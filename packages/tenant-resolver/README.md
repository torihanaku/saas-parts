# @torihanaku/tenant-resolver

メールアドレス→tenant_id の解決（デフォルトテナントのプロセス内キャッシュ、#952 の stale 行ドメインバックフィル、getOrCreateDefaultTenant、requireTenant/requireUser ガード付き）を行うマルチテナント基盤モジュール。

## 主要API

```ts
import { createTenantResolver, requireTenant, type TenantStore } from "@torihanaku/tenant-resolver";

const store: TenantStore = {
  // Supabase 実装例（元実装のクエリと 1:1 対応）
  findMemberByEmail: (email) => /* dashboard_team_members?email=eq.{email}&select=tenant_id&limit=1 */ null,
  findTenantByOwnerEmail: (email) => /* tenants?owner_email=eq.{email}&select=id&limit=1 */ null,
  findTenantBySlug: (slug) => /* tenants?slug=eq.{slug}&select=id&limit=1 */ null,
  findTenantByDomain: (domain) => /* tenants?owner_email=like.*@{domain}&order=created_at.asc&limit=1 */ null,
  createTenant: (input) => /* POST tenants (Prefer: return=representation) → id */ null,
};

const resolver = createTenantResolver<Request>({
  store,
  adminEmail: "owner@example.com",          // 元: env.ADMIN_EMAIL
  getSessionEmail: (req) => mySession(req),  // 元: getSessionEmail (auth.ts)
});

const tenantId = await resolver.getTenantId(req);      // member → backfill → default の順で解決
const def = await resolver.getOrCreateDefaultTenant(); // owner_email → slug='admin' → create → retry

// ミドルウェアで req.tenantId / req.userId を事前設定している場合の同期ガード
const t = requireTenant(req); // 無ければ throw "Tenant not resolved"
```

### 解決順序

- `getTenantId(req)`: セッション email 無し or `"admin"` → デフォルトテナント。member 行に tenant_id あり → それを返す。member 行はあるが tenant_id が NULL → owner_email 完全一致 → email ドメイン一致でバックフィル（#952 hardening）。それでも無ければデフォルトテナント。
- `getOrCreateDefaultTenant()`: インスタンス内キャッシュ → owner_email=adminEmail → slug='admin' → 新規作成 → slug='admin' 再試行（作成レース対策）。全滅時は警告ログを出して null。

## 依存

- peerDeps / 外部依存なし（fetch も不使用。ストレージは全て注入）

## 注入ポイント

| 注入先 | 元実装 |
|---|---|
| `store: TenantStore` | Supabase REST（dashboard_team_members / tenants テーブル） |
| `getSessionEmail(req)` | `server/lib/auth.ts` の `getSessionEmail` |
| `adminEmail` | `env.ADMIN_EMAIL` |
| `logWarn` | `console.warn(JSON.stringify({severity:"WARNING",...}))` |

- キャッシュは「プロセスごと」→「resolver インスタンスごと」に変更（テスト分離のため。1 プロセス 1 インスタンスなら等価）。
- 元実装にあった「Supabase 未設定なら即 null」ガードは store 注入化に伴い削除（未設定の判断は store 実装側の責務）。

## 想定ランタイム

Node.js 18+ / Bun / Cloud Run 等のサーバーサイド（DOM 不要、`Request` 型はジェネリクスで任意の型に差し替え可能）。

## 出典

- `dev-dashboard-v2/server/lib/tenant.ts` (~276 LOC, #641 分割 / #952 hardening)
- テスト移植元: `dev-dashboard-v2/tests/tenant.test.ts`
