/**
 * Tenant management: resolve or create tenants for the current request.
 *
 * 移植元: 実運用SaaS server/lib/tenant.ts (分割元: server/lib/auth.ts, Issue #641)
 *
 * #952 hardening (2026-04-20): The previous implementation silently swallowed every
 * storage error, returning `null` from `getOrCreateDefaultTenant()` whenever the
 * default tenant didn't exist or the create call failed. Callers then surfaced
 * "Tenant not resolved" 401 across ~8 admin pages with zero diagnostic signal.
 *
 * Changes preserved from the original:
 *   1. Log storage failures so we can tell *why* the lookup failed.
 *   2. Cache the resolved default-tenant UUID (per resolver instance) so we don't
 *      hammer the backing store on every hot-path request.
 *   3. Fall back to a static `slug='admin'` lookup when adminEmail is empty or
 *      the literal sentinel "admin".
 *   4. Resolve members by team-member email first.
 *   5. Backfill: when a team-member row exists but its tenant_id is NULL, look up
 *      a tenant by owner email (#952 hotfix). Email-domain backfill is opt-in
 *      (`backfillByEmailDomain`).
 *
 * SA-0003 (2026-11-02, fail-closed): getTenantId は未ログイン・未登録・lookup 例外の
 * 利用者を既定テナント（運営者のテナント）へ落とさず null を返す。既定テナントへ送るのは
 * "admin" センチネルと adminEmail の本人だけ。旧挙動は `fallbackUnmappedToDefaultTenant`
 * で明示的にオプトインした場合だけ（ログイン済みの未登録 email に限る）。
 *
 * 依存の切り離し:
 *   - Supabase (dashboard_team_members / tenants テーブル) への参照 → `TenantStore`
 *   - セッション email の取得 (getSessionEmail) → 注入コールバック
 *   - env.ADMIN_EMAIL → options.adminEmail
 */

export const DEFAULT_ADMIN_SLUG = "admin";

/** dashboard_team_members 相当の行 (email 検索結果)。行が無い場合は null。 */
export interface TenantMemberRow {
  tenant_id: string | null;
}

/** tenants 相当の新規作成入力 (元実装の POST body をミラー)。 */
export interface CreateTenantInput {
  name: string;
  slug: string;
  owner_email: string;
  plan: string;
  is_active: boolean;
}

/**
 * ストレージ抽象。元実装の Supabase REST クエリを 1:1 でメソッドに写像:
 *   - findMemberByEmail      … dashboard_team_members?email=eq.{email}&select=tenant_id&limit=1
 *   - findTenantByOwnerEmail … tenants?owner_email=eq.{email}&select=id&limit=1
 *   - findTenantBySlug       … tenants?slug=eq.{slug}&select=id&limit=1
 *   - findTenantByDomain     … tenants?owner_email=like.*@{domain}&limit=1&order=created_at.asc
 *   - createTenant           … POST tenants (Prefer: return=representation) → id
 *
 * 各メソッドは「見つからない」= null を返す。異常 (ネットワーク等) は throw してよい —
 * リゾルバ側が捕捉して警告ログを出し、元実装と同じフォールバック順で継続する。
 */
export interface TenantStore {
  findMemberByEmail(email: string): Promise<TenantMemberRow | null>;
  findTenantByOwnerEmail(email: string): Promise<string | null>;
  findTenantBySlug(slug: string): Promise<string | null>;
  findTenantByDomain(domain: string): Promise<string | null>;
  createTenant(input: CreateTenantInput): Promise<string | null>;
}

export type TenantWarnLogger = (message: string, extra?: Record<string, unknown>) => void;

/** 元実装の logTenantWarn (構造化 JSON を console.warn) と同等のデフォルト。 */
export function defaultTenantWarnLogger(message: string, extra?: Record<string, unknown>): void {
  console.warn(JSON.stringify({ severity: "WARNING", message, ...extra }));
}

export interface TenantResolverOptions<TReq = unknown> {
  store: TenantStore;
  /** リクエストからセッション email を取り出すコールバック (元: getSessionEmail from auth.ts)。 */
  getSessionEmail: (req: TReq) => Promise<string | null> | string | null;
  /** システムオーナーの email (元: env.ADMIN_EMAIL)。未設定なら "admin" センチネル運用。 */
  adminEmail?: string;
  /** 警告ロガー (デフォルト: JSON を console.warn)。 */
  logWarn?: TenantWarnLogger;
  /**
   * 既定 false。true のとき、ログイン済みで member 行もバックフィルも当たらない email を
   * 既定テナント（運営者のテナント）へ送る（旧挙動）。
   *
   * 危険: 誰でもログインできる構成で true にすると、未登録の第三者が運営者のテナントの
   * データを読み書きできる（SA-0003）。招待制などで「ログインできる＝運営者側の人」と
   * 保証できる場合だけ使うこと。未ログイン（email が null/空）と lookup 例外は true でも null。
   */
  fallbackUnmappedToDefaultTenant?: boolean;
  /**
   * 既定 false。true のとき、member 行の tenant_id が NULL で owner_email の完全一致が
   * 外れた場合に、email ドメインが一致するテナントでもバックフィルする（#952 の旧挙動）。
   *
   * 危険: gmail.com などの共有ドメインでは、無関係な利用者が同じドメインの別テナントに
   * 紐づく。自社ドメインだけで運用し、ドメイン＝所属と保証できる場合だけ使うこと。
   */
  backfillByEmailDomain?: boolean;
}

export interface TenantResolver<TReq = unknown> {
  /**
   * Get or create the default tenant for the system owner.
   *
   * Resolution order:
   *   1. cached value (per-resolver instance)
   *   2. tenants WHERE owner_email = adminEmail (if set)
   *   3. tenants WHERE slug = 'admin' (fallback so it works without adminEmail)
   *   4. create a fresh tenant with owner_email = adminEmail || 'admin'
   *   5. slug='admin' retry (create race)
   */
  getOrCreateDefaultTenant(): Promise<string | null>;
  /**
   * Resolve the tenant_id for the current request's user (fail-closed).
   *
   * Resolution order:
   *   1. no session email (null / "") → null（既定テナントを作らない）
   *   2. "admin" sentinel → getOrCreateDefaultTenant()
   *   3. member lookup threw → warn + null（adminEmail の本人でも null）
   *   4. member.tenant_id set → that value
   *   5. member row with NULL tenant_id → owner_email exact match backfill
   *      (+ domain match only when `backfillByEmailDomain: true`)
   *   6. adminEmail itself → getOrCreateDefaultTenant()
   *   7. `fallbackUnmappedToDefaultTenant: true` → getOrCreateDefaultTenant()
   *   8. otherwise → null
   */
  getTenantId(req: TReq): Promise<string | null>;
  /** Reset the cached default-tenant id (for tests). */
  resetDefaultTenantCache(): void;
}

export function createTenantResolver<TReq = unknown>(
  options: TenantResolverOptions<TReq>,
): TenantResolver<TReq> {
  const { store, getSessionEmail } = options;
  const adminEmail = options.adminEmail || "";
  const logWarn = options.logWarn ?? defaultTenantWarnLogger;
  const fallbackUnmappedToDefaultTenant = options.fallbackUnmappedToDefaultTenant === true;
  const backfillByEmailDomain = options.backfillByEmailDomain === true;

  let cachedDefaultTenantId: string | null = null;

  async function fetchTenantIdByOwner(email: string): Promise<string | null> {
    try {
      return await store.findTenantByOwnerEmail(email);
    } catch (e: unknown) {
      logWarn("tenant: owner_email lookup threw", {
        owner_email: email,
        error: (e as Error).message,
      });
      return null;
    }
  }

  async function fetchTenantIdBySlug(slug: string): Promise<string | null> {
    try {
      return await store.findTenantBySlug(slug);
    } catch (e: unknown) {
      logWarn("tenant: slug lookup threw", { slug, error: (e as Error).message });
      return null;
    }
  }

  async function createDefaultTenant(ownerEmail: string, slug: string): Promise<string | null> {
    try {
      // NOTE: 元実装の `tenants` テーブルには `type` カラムが無い。`tenant.type === 'agency'`
      // の区別はアプリ層で行う (agency-access パッケージ参照)。ここで type を送ると
      // PostgREST が 4xx を返して create パスが静かに失敗した (#952 hotfix 2026-04-20)。
      return await store.createTenant({
        name: ownerEmail === "admin" ? "Default" : ownerEmail.split("@")[0] ?? "Default",
        slug,
        owner_email: ownerEmail,
        plan: "free",
        is_active: true,
      });
    } catch (e: unknown) {
      logWarn("tenant: create threw", {
        owner_email: ownerEmail,
        slug,
        error: (e as Error).message,
      });
      return null;
    }
  }

  /**
   * Best-effort: backfill `tenant_id` for a team-member row that has the column NULL
   * by looking up the tenant whose owner email matches the user's email exactly.
   * Domain match is attempted only when `backfillByEmailDomain` is true (SA-0003:
   * shared domains such as gmail.com would otherwise link unrelated users).
   * Store errors are treated as "not found" (#952 hotfix).
   */
  async function findTenantByEmailOrDomain(email: string): Promise<string | null> {
    // Try owner_email exact match first.
    try {
      const exact = await store.findTenantByOwnerEmail(email);
      if (exact) return exact;
    } catch {
      /* fall through */
    }
    if (!backfillByEmailDomain) return null;
    // Opt-in: email domain match against any tenant owner with the same domain.
    const domain = email.split("@")[1];
    if (!domain) return null;
    try {
      const byDomain = await store.findTenantByDomain(domain);
      if (byDomain) return byDomain;
    } catch {
      /* fall through */
    }
    return null;
  }

  async function getOrCreateDefaultTenant(): Promise<string | null> {
    if (cachedDefaultTenantId) return cachedDefaultTenantId;

    const ownerEmail = adminEmail || "admin";
    const slugFromEmail =
      ownerEmail
        .split("@")[0]!
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-") || DEFAULT_ADMIN_SLUG;

    // (2) by owner_email
    if (adminEmail) {
      const byOwner = await fetchTenantIdByOwner(adminEmail);
      if (byOwner) {
        cachedDefaultTenantId = byOwner;
        return byOwner;
      }
    }

    // (3) by slug='admin' (works even without adminEmail)
    const bySlug = await fetchTenantIdBySlug(DEFAULT_ADMIN_SLUG);
    if (bySlug) {
      cachedDefaultTenantId = bySlug;
      return bySlug;
    }

    // (4) create
    const created = await createDefaultTenant(ownerEmail, slugFromEmail);
    if (created) {
      cachedDefaultTenantId = created;
      return created;
    }

    // Last-ditch: try slug='admin' once more in case of race
    const retry = await fetchTenantIdBySlug(DEFAULT_ADMIN_SLUG);
    if (retry) {
      cachedDefaultTenantId = retry;
      return retry;
    }

    logWarn("tenant: getOrCreateDefaultTenant exhausted all paths", {
      admin_email_set: Boolean(adminEmail),
    });
    return null;
  }

  async function getTenantId(req: TReq): Promise<string | null> {
    const email = await getSessionEmail(req);
    // (1) 未ログイン → null。既定テナントを作らない（SA-0003）。
    if (!email) return null;
    // (2) "admin" センチネル → 既定テナント（今までどおり）。
    if (email === "admin") return getOrCreateDefaultTenant();

    let member: TenantMemberRow | null;
    try {
      member = await store.findMemberByEmail(email);
    } catch (e: unknown) {
      // (3) lookup 失敗 → fail-closed（adminEmail の本人でも null）。
      logWarn("tenant: team_members lookup threw", {
        email,
        error: (e as Error).message,
      });
      return null;
    }

    if (member) {
      // (4) 紐づき済み。
      if (member.tenant_id) return member.tenant_id;
      // (5) member 行はあるが tenant_id が NULL — owner_email 完全一致（opt-in でドメイン）で
      // バックフィル (#952 hotfix)。
      const linkable = await findTenantByEmailOrDomain(email);
      if (linkable) return linkable;
    }

    // (6) システムオーナー本人 → 既定テナント。
    if (adminEmail && email === adminEmail) return getOrCreateDefaultTenant();
    // (7) 明示オプトイン時だけ、ログイン済みの未登録 email を既定テナントへ。
    if (fallbackUnmappedToDefaultTenant) return getOrCreateDefaultTenant();
    // (8) 解決できない → null（呼び出し側で 403 等にする）。
    return null;
  }

  return {
    getOrCreateDefaultTenant,
    getTenantId,
    resetDefaultTenantCache(): void {
      cachedDefaultTenantId = null;
    },
  };
}

// ─── Request guards ──────────────────────────────────────────────────────────

/**
 * Require a resolved tenant_id. Throws if unresolvable.
 * ミドルウェア等で req に事前設定された `tenantId` を読む (元実装と同じ契約)。
 */
export function requireTenant(req: object): string {
  const tenantId = (req as { tenantId?: string | null }).tenantId;
  if (!tenantId) {
    throw new Error("Tenant not resolved");
  }
  return tenantId;
}

/**
 * Require a resolved user_id. Throws if unresolvable.
 */
export function requireUser(req: object): string {
  const userId = (req as { userId?: string | null }).userId;
  if (!userId) {
    throw new Error("User not authenticated");
  }
  return userId;
}
