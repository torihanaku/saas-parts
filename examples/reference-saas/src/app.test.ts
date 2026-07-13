/**
 * リファレンス実装の結合テスト。部品を配線した結果として、
 * テナント分離・監査チェーン・認証ゲート・レート制限・セキュリティヘッダが
 * 実際に効いていることを、ハンドラを直接叩いて検証する。
 */
import { describe, it, expect } from "vitest";
import { createApp } from "./app";

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/** ログインして Set-Cookie から session=... を取り出す。 */
async function login(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.handle(req("POST", "/login", { body: { email } }));
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie")!;
  return setCookie.split(";")[0]!; // "session=<token>"
}

describe("reference-saas — 部品配線の結合テスト", () => {
  it("未ログインは 401", async () => {
    const app = createApp();
    const res = await app.handle(req("GET", "/widgets"));
    expect(res.status).toBe(401);
  });

  it("全レスポンスにセキュリティヘッダが付く", async () => {
    const app = createApp();
    const res = await app.handle(req("GET", "/widgets"));
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("テナント分離: A の widget は B から見えない", async () => {
    const app = createApp();
    const alice = await login(app, "alice@acme.com");
    const bob = await login(app, "bob@globex.com");

    const created = await app.handle(req("POST", "/widgets", { cookie: alice, body: { name: "A-secret" } }));
    expect(created.status).toBe(201);

    const aList = await (await app.handle(req("GET", "/widgets", { cookie: alice }))).json();
    expect(aList.tenant).toBe("tenant-acme");
    expect(aList.widgets.map((w: { name: string }) => w.name)).toContain("A-secret");

    const bList = await (await app.handle(req("GET", "/widgets", { cookie: bob }))).json();
    expect(bList.tenant).toBe("tenant-globex");
    expect(bList.widgets).toHaveLength(0); // B は A の widget を一切見られない
  });

  it("書き込みは監査ログに記録され、ハッシュチェーンが検証できる", async () => {
    const app = createApp();
    const alice = await login(app, "alice@acme.com");
    await app.handle(req("POST", "/widgets", { cookie: alice, body: { name: "w1" } }));
    await app.handle(req("POST", "/widgets", { cookie: alice, body: { name: "w2" } }));

    const verify = await (await app.handle(req("GET", "/audit/verify", { cookie: alice }))).json();
    expect(verify.ok).toBe(true);

    // 改ざんすると検証が false になる（改ざん検知）
    const rows = app.auditStore.rows.filter((r) => r.tenant_id === "tenant-acme");
    expect(rows.length).toBe(2);
    (rows[0]!.changes as { name: string }).name = "tampered";
    const verify2 = await (await app.handle(req("GET", "/audit/verify", { cookie: alice }))).json();
    expect(verify2.ok).toBe(false);
  });

  it("レート制限: /login は auth ティア(30/min)を超えると 429", async () => {
    const app = createApp();
    let last = 200;
    for (let i = 0; i < 31; i++) {
      const res = await app.handle(req("POST", "/login", { body: { email: "alice@acme.com" } }));
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("不正な email のログインは 400", async () => {
    const app = createApp();
    const res = await app.handle(req("POST", "/login", { body: { email: "not-an-email" } }));
    expect(res.status).toBe(400);
  });
});
