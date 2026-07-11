# @torihanaku/consent

**用途**: 目的（purpose）ベースの同意管理 — 60秒TTLキャッシュ付き同意チェック、grant/revoke 操作、失効時の依存データ連鎖削除（revocation cascade）、法的根拠（legal basis）分類。

## 主要API例

```ts
import {
  createConsentGuard,
  InMemoryConsentStore,
  ConsentMissingError,
  EXAMPLE_CONSENT_PURPOSES,
  EXAMPLE_COS_REVOCATION_CASCADE,
} from "@torihanaku/consent";

// purpose はアプリ側で定義する string union（ジェネリクスで注入）
type MyPurpose = "ai_learning" | "email_digest" | "usage_analytics";

const store = new InMemoryConsentStore(); // 本番は Supabase/Postgres 実装を注入

const guard = createConsentGuard<MyPurpose>({
  store,
  // 失効時にどのテーブルを掃除するかは呼び出し側の設定（or コールバック）
  revocationCascade: {
    ai_learning: [
      { table: "ml_training_samples" },                       // tenant_id で全削除
      { table: "digest_items", filters: { source_type: "slack" } }, // 追加フィルタ付き
    ],
  },
});

// チェック（60秒TTLキャッシュ、ストア障害時は fail-closed で false）
if (await guard.hasConsent(userId, tenantId, "ai_learning")) { /* ... */ }

// ガード（未同意なら ConsentMissingError: status=403, code=CONSENT_MISSING を throw）
await guard.requireConsent(userId, tenantId, "ai_learning");

// 付与 / 失効（キャッシュ自動無効化。失効時は cascade も実行）
await guard.grantConsent(tenantId, userId, "ai_learning", "explicit_consent");
const { cascade } = await guard.revokeConsent(tenantId, userId, "ai_learning");

// 別経路（API等）で grant/revoke した場合の手動キャッシュ無効化
guard.invalidateConsentCache(userId, tenantId, "ai_learning");
```

- 法的根拠は `ConsentBasis` = `explicit_consent | contract | legal_obligation | legitimate_interest`。
- 元実装の purpose 一覧は `EXAMPLE_CONSENT_PURPOSES`、COS 向け cascade 設定は `EXAMPLE_COS_REVOCATION_CASCADE` として文書化のため同梱。

## 依存

- なし。peerDependencies なし。

## 注入ポイント

| 注入先 | 型 | 元実装での実体 |
|---|---|---|
| `store` | `ConsentStore`（`hasActiveConsent` / `grant` / `revoke` / `deleteRows`） | Supabase の `sup_consent_registry` テーブル＋`supabaseDelete` |
| purpose | ジェネリクス `TPurpose extends string` | ハードコードされた `CONSENT_PURPOSES` union |
| `revocationCascade` | 宣言的マップ or `(tenantId, purpose) => Promise<結果[]>` | `onConsentRevoked` 内にハードコードされた COS テーブルマッピング |
| `cacheTtlMs` | number（任意） | 60,000ms 固定 |
| `onError` / `log` | 関数（任意） | `console.error` / `console.warn`（既定値も同じ） |

## 想定スキーマ（元実装の migration を転記）

`dev-dashboard-v2/supabase/migrations/202604200005_005_consent_registry.sql` より:

```sql
CREATE TABLE IF NOT EXISTS sup_consent_registry (
  id UUID DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  purpose TEXT NOT NULL, -- e.g., 'slack_ingestion', 'ai_learning'
  basis TEXT NOT NULL,   -- e.g., 'explicit_consent', 'contract'
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, user_id, purpose)
);

CREATE INDEX IF NOT EXISTS idx_consent_active ON sup_consent_registry (tenant_id, user_id)
  WHERE revoked_at IS NULL;

-- 退職者フラグは既存 auth.users に追加
DO $$
BEGIN
  ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS deleted_member_flag BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping auth.users.deleted_member_flag: insufficient privileges in local Supabase bootstrap';
END $$;
```

## 想定ランタイム

Node.js 18+ / Bun / エッジランタイム（Node固有APIなし。`Map` と `Date.now()` のみ）。
キャッシュはガードのインスタンス単位（元実装はモジュールグローバル）。プロセス内キャッシュのため、マルチインスタンス構成では revoke 後最大 TTL（60秒）の伝播遅延が起こり得る点は元実装と同じ。

## 出典パス

- `dev-dashboard-v2/server/lib/consent-guard.ts`（約140行）
- `dev-dashboard-v2/shared/types/consent.ts`（約47行）
- `dev-dashboard-v2/supabase/migrations/202604200005_005_consent_registry.sql`（スキーマ）
- テスト出典: `dev-dashboard-v2/tests/integration/consent-wiring.test.ts`（Consent Guard セクション）
