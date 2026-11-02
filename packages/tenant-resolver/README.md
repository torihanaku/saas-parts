# @torihanaku/tenant-resolver

メールアドレス→tenant_id の解決（解決できなければ null を返す fail-closed 方式、デフォルトテナントのプロセス内キャッシュ、#952 の stale 行バックフィル（ドメイン一致はオプトイン）、getOrCreateDefaultTenant、requireTenant/requireUser ガード付き）を行うマルチテナント基盤モジュール。

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
  // fallbackUnmappedToDefaultTenant: false,  // 既定 false（下の「オプトイン」参照）
  // backfillByEmailDomain: false,            // 既定 false（下の「オプトイン」参照）
});

const tenantId = await resolver.getTenantId(req);      // 解決できなければ null → 呼び出し側で 403 にする
if (!tenantId) return new Response("Forbidden", { status: 403 });
const def = await resolver.getOrCreateDefaultTenant(); // owner_email → slug='admin' → create → retry

// ミドルウェアで req.tenantId / req.userId を事前設定している場合の同期ガード
const t = requireTenant(req); // 無ければ throw "Tenant not resolved"
```

### 解決順序

`getTenantId(req)` は上から順に判定する:

1. セッション email が null または空文字（未ログイン・失効）→ **null**（デフォルトテナントを作らない）
2. email が `"admin"`（センチネル）→ デフォルトテナント
3. `findMemberByEmail` が例外を投げた（DB 障害など）→ 警告ログを出して **null**（adminEmail の本人でも null）
4. member 行に tenant_id あり → それを返す
5. member 行はあるが tenant_id が NULL → owner_email 完全一致でバックフィル（#952）。`backfillByEmailDomain: true` のときだけ email ドメイン一致も試す
6. 5 までで決まらず、email が adminEmail の本人 → デフォルトテナント
7. 5 までで決まらず、`fallbackUnmappedToDefaultTenant: true` → デフォルトテナント
8. どれにも当たらない（未登録の email など）→ **null**

**null になる条件**: 未ログイン（email が null/空）／lookup の例外／member 行が無い未登録の email（オーナー以外）／member 行の tenant_id が NULL でバックフィルにも当たらない。null を受けた呼び出し側は 403 などで拒否すること（`examples/reference-saas` は 403 を返す）。

`"admin"` センチネルは無条件でデフォルトテナント（=運営者のテナント）に入る。外部の ID プロバイダや利用者入力から `"admin"` という email が届き得る構成では、`getSessionEmail` 側で弾くこと。

### オプトイン（どちらも既定 false）

| オプション | true にしたときの動き | 危険 |
|---|---|---|
| `fallbackUnmappedToDefaultTenant` | ログイン済みで member 行もバックフィルも当たらない email をデフォルトテナントへ送る（旧挙動）。未ログインと lookup 例外は true でも null | 誰でもログインできる構成では、未登録の第三者が運営者のテナントのデータを読み書きできる（SA-0003）。招待制などで「ログインできる＝運営者側の人」と保証できる場合だけ使う |
| `backfillByEmailDomain` | member 行の tenant_id が NULL で owner_email が外れたとき、email ドメインが一致するテナントでもバックフィルする（#952 の旧挙動） | gmail.com などの共有ドメインでは、無関係な利用者が同じドメインの別テナントに所属させられる。自社ドメインだけで運用し、ドメイン＝所属と保証できる場合だけ使う |

- `getOrCreateDefaultTenant()`: インスタンス内キャッシュ → owner_email=adminEmail → slug='admin' → 新規作成 → slug='admin' 再試行（作成レース対策）。全滅時は警告ログを出して null。

## 破壊的変更（2026-11-02 / SA-0003）

- `getTenantId` は、未ログイン（email が null/空）・lookup の例外・未登録の email のとき、デフォルトテナントではなく **null** を返すようになった。以前は全てデフォルトテナント（運営者のテナント）に落ちていた。null を「拒否」として扱う呼び出し側のコードが必要。
- email が null のとき、デフォルトテナントの検索・作成（`findTenantBySlug` / `createTenant`）を行わなくなった。
- email ドメイン一致によるバックフィルは既定で無効になった。必要なら `backfillByEmailDomain: true` を指定する。
- 旧挙動（未登録の email をデフォルトテナントへ）が必要な場合は `fallbackUnmappedToDefaultTenant: true` を指定する（危険は上の表を参照）。
- 変わらないもの: `"admin"` センチネルと adminEmail の本人はデフォルトテナント。`getOrCreateDefaultTenant()` の動きと戻り値。member 行に tenant_id がある利用者の解決結果。

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

- `実運用SaaS/server/lib/tenant.ts` (~276 LOC, #641 分割 / #952 hardening)
- テスト移植元: `実運用SaaS/tests/tenant.test.ts`
