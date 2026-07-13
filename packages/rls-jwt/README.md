# @torihanaku/rls-jwt

## 用途

Postgres RLS（Row Level Security）の段階的ロールアウトを支える、テナントスコープ HS256 JWT のミント＆canary シャドー比較ヘルパー。PostgREST（Supabase 等）が同じ secret で署名検証し、`current_setting('request.jwt.claims',true)::json` の `tenant_id` クレームを RLS ポリシーが参照する構成を想定。

## ステージモデル

| Stage | 挙動 |
|-------|------|
| 1（既定） | service_role ヘッダのみ。tenant_id はアプリ層でフィルタ。安全なデフォルト |
| 2（canary） | primary=service_role のまま、テナントJWTでシャドークエリを並走。行数を比較し、不一致は `rls_shadow_mismatch`（WARNING）としてログ。7日以上ソークしてから昇格 |
| 3 | テナントJWTが primary。service_role はクロステナント管理（GDPRカスケード等）専用。昇格前に旧 `service_role_all` ポリシーを DROP する |

## 主要API（コード例）

```ts
import { createRlsJwt, decodeTenantJwt } from "@torihanaku/rls-jwt";

// すべて関数で注入する（値でなく関数な理由: secret/stage のローテーションを
// プロセス再起動なしで反映するため。secret は mint のたびに読まれる）
const rls = createRlsJwt({
  jwtSecret: () => secretManager.get("SUPABASE_JWT_SECRET"), // 必須
  apiKey: () => secretManager.get("SUPABASE_SERVICE_ROLE_KEY"), // 省略可
  stage: () => flagStore.get("RLS_STAGE"),                   // 省略時 Stage 1
  warn: (entry) => logger.warn(entry),                       // 省略時 console.warn(JSON)
});

// ステージ判定（キャッシュされる。昇格を反映するには _resetRlsStageCache()）
const stage = rls.getRlsStage(); // 1 | 2 | 3

// テナントJWTのミント（exp 既定 300 秒）
const jwt = rls.mintTenantJwt(tenantId, { role: "authenticated", expSec: 300, sub: "user-1" });

// PostgREST へのリクエストヘッダ（apikey + Bearer テナントJWT）
const headers = rls.tenantScopedHeaders(tenantId);

// Stage 2 シャドー比較。primary の結果を必ず返す（shadow の失敗は本番を止めない）
const res = await rls.runWithRlsShadow(
  "match_characters_by_embedding",
  () => queryWithServiceRole(),
  () => queryWithTenantJwt(headers)
);

// 比較結果の購読（メトリクス送信など。購読者は1つ・後勝ち）
rls.onRlsShadowDiff((diff) => metrics.record(diff));

// 検査用デコード（署名検証はしない）
decodeTenantJwt(jwt); // { role, tenant_id, iat, exp, ... } | null
```

## 設計メモ

- **env 読み取りなし**: 元実装は `process.env.RLS_STAGE` / `SUPABASE_JWT_SECRET` を直接読んでいた（Zod-frozen env module を迂回してローテーション対応するため）。本パッケージでは同じ「毎回読む」性質を source 関数の注入で実現している
- stage は初回解決後キャッシュ。`_resetRlsStageCache()`（元実装のテスト用APIを踏襲）で再読込
- `mintTenantJwt` は secret 未設定時に throw する — service_role への静かなフォールバックは canary の意味を壊すため
- shadow 側の例外・購読者の例外は握りつぶして primary を返す（本番非ブロッキング保証）
- ランタイム: Node（`node:crypto` の HMAC / `Buffer` を使用）。外部依存ゼロ

## 出自

`実運用SaaS/server/lib/rls-jwt.ts`（218 LOC, issue #1016 / Epic #699 G9 Sprint 0 F-2）。モジュールレベル関数＋env 直読みを、`createRlsJwt(sources)` ファクトリ＋注入に変換した以外はロジック同一。テストは `tests/rls-jwt.test.ts` を移植（env 変異 → fixture 変異）。
