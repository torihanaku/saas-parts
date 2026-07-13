/**
 * Reference SaaS — saas-parts の部品を1つに配線した最小の動くSaaS。
 *
 * 配線している部品:
 *   - auth-session      … セッションCookie（HMAC署名＋期限検証）
 *   - security-headers  … 全レスポンスにCSP/HSTS等
 *   - rate-limiter      … IP×ティア別レート制限（インメモリ）
 *   - tenant-resolver   … email → tenant_id 解決
 *   - audit-log         … 変更操作の改ざん検知ハッシュチェーン
 *
 * 全ハンドラは (Request) => Response の純関数なので、ポートを開かずにテストできる。
 * server.ts が Bun.serve で公開する。
 */
import { createTokenService } from "@torihanaku/auth-session";
import { RateLimiter, getRateLimitKey } from "@torihanaku/rate-limiter";
import { createTenantResolver } from "@torihanaku/tenant-resolver";
import { createAuditLogger, verifyHashChain, InMemoryAuditStore } from "@torihanaku/audit-log";
import { securityHeadersFor } from "@torihanaku/security-headers";
import { InMemoryTenantStore, WidgetStore } from "./stores";

export interface AppOptions {
  /** セッション署名鍵。本番は env 検証後に composition root で注入する。 */
  secret?: string;
}

export function createApp(opts: AppOptions = {}) {
  const secret = opts.secret ?? "dev-only-secret-at-least-32-characters-long";
  const tokens = createTokenService({ secret });
  const rateLimiter = new RateLimiter({ cleanupIntervalMs: 0 }); // デモ: 定期スイープ無効
  const tenantStore = new InMemoryTenantStore();
  const auditStore = new InMemoryAuditStore();
  const widgets = new WidgetStore();

  /** Cookie からセッションを検証して email を返す（署名＋有効期限をチェック）。 */
  async function sessionEmail(req: Request): Promise<string | null> {
    const cookie = req.headers.get("cookie") ?? "";
    const m = cookie.match(/(?:^|;\s*)session=([^;]+)/);
    if (!m) return null;
    const data = tokens.verifySessionToken(m[1]!); // "auth:<email>:<expires>" or null
    if (!data) return null;
    return data.split(":")[1] ?? null;
  }

  const tenantResolver = createTenantResolver<Request>({
    store: tenantStore,
    getSessionEmail: (req) => sessionEmail(req),
  });

  const audit = createAuditLogger({
    store: auditStore,
    context: {
      getCurrentUserRole: async (req) => ({
        email: (await sessionEmail(req)) ?? "anonymous",
        role: "member",
      }),
      getTenantId: (req) => tenantResolver.getTenantId(req),
    },
  });

  function withSecurity(res: Response): Response {
    for (const [k, v] of Object.entries(securityHeadersFor())) res.headers.set(k, v);
    return res;
  }
  const json = (body: unknown, init?: ResponseInit) => withSecurity(Response.json(body, init));

  async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const method = req.method;

    // 1) レート制限（IP × ティア）
    const tier = method === "POST" && pathname === "/login" ? "auth" : method === "GET" ? "read" : "write";
    const rl = await rateLimiter.checkRateLimit(getRateLimitKey(req), tier);
    if (!rl.allowed) return json({ error: "rate_limited", retryAfter: rl.retryAfter }, { status: 429 });

    // 2) ログイン（デモ: パスワード無し。email でセッションを発行）
    if (method === "POST" && pathname === "/login") {
      const body = (await req.json().catch(() => ({}))) as { email?: unknown };
      if (typeof body.email !== "string" || !body.email.includes("@")) {
        return json({ error: "valid email required" }, { status: 400 });
      }
      const token = await tokens.createSessionCookie(body.email);
      const res = json({ ok: true, email: body.email });
      res.headers.set("set-cookie", tokens.formatSessionCookie(token));
      return res;
    }

    // 3) 認証ゲート（以降は要ログイン）
    const email = await sessionEmail(req);
    if (!email) return json({ error: "unauthenticated" }, { status: 401 });
    const tenantId = await tenantResolver.getTenantId(req);
    if (!tenantId) return json({ error: "no tenant" }, { status: 403 });

    // 4) テナントスコープの読み取り
    if (method === "GET" && pathname === "/widgets") {
      return json({ tenant: tenantId, widgets: widgets.list(tenantId) });
    }

    // 5) テナントスコープの書き込み＋監査ログ
    if (method === "POST" && pathname === "/widgets") {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      if (typeof body.name !== "string" || !body.name) {
        return json({ error: "name required" }, { status: 400 });
      }
      const w = widgets.create(tenantId, body.name);
      await audit.logAudit(req, {
        action: "create",
        resourceType: "widget",
        resourceId: w.id,
        changes: { name: body.name },
      });
      return json({ ok: true, widget: w }, { status: 201 });
    }

    // 6) 監査ログの改ざん検知（ハッシュチェーン検証）
    if (method === "GET" && pathname === "/audit/verify") {
      const ok = await verifyHashChain(auditStore, tenantId).then(() => true).catch(() => false);
      return json({ ok });
    }

    return json({ error: "not found" }, { status: 404 });
  }

  return { handle, auditStore, tenantResolver };
}

export type App = ReturnType<typeof createApp>;
