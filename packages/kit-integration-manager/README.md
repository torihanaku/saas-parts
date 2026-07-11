# @torihanaku/kit-integration-manager

外部SaaS統合マネージャーの汎用コア。テナント別の統合接続管理 → fire-and-wait同期（トリガー＋ポーリング）→ データ正規化取り込み → マルチプラットフォーム・コンテンツ発行 → 接続ヘルスチェックまでを、provider-agnostic な `IntegrationProvider` 契約の上で提供する。

dev-dashboard-v2 の Nango（統合ハブSaaS）連携システムから抽出。Nango実装は「注入可能な一プロバイダ」（`providers/nango.ts`、実働コード）に落とし、コアはプロバイダ非依存。

## 機能説明

- **接続管理**: OAuth接続セッションの作成（`connect` → フロントに渡すトークン）、接続一覧・削除。`client_{clientId}_{integrationId}` の接続ID規約で、テナント内の顧客（クライアント）単位に接続を分離できる（`connection-id.ts`）。
- **fire-and-wait 同期**: `triggerAndWaitForSync` が同期をトリガーし、完了までポーリング。状態機械は元実装のまま — trigger失敗→`{ok:false}` / status `success|SUCCESS`→`{ok:true}` / `error|ERROR`→`{ok:false,status}` / 期限超過→`{ok:false,status:"timeout"}`（既定: 2秒間隔・30秒上限）。複数接続の並列トリガーは `triggerSyncBatch`。
- **データ正規化取り込み（SyncEngine）**: プロバイダからレコードを取得（既定50件）→ 同意ゲート → 統合別ノーマライザで正規化 → `external_id` による重複排除（upsert）→ 注入された `RecordSink` へ保存。統合ごとの `model`（"messages" / "emails" 等）とノーマライザは `NormalizerRegistry` に登録し、未登録の統合は汎用フォールバックで取り込む。
- **マルチプラットフォーム発行**: 下書き（title/content）を Slack / WordPress / LinkedIn / LINE / Mailchimp / note へ、プロバイダの認証付きプロキシ経由で並列発行。プラットフォーム別のエンドポイント・ボディ構築（文字数上限含む）は元実装のまま。
- **ヘルスチェック**: `validateConnection`（接続がプロバイダ側に実在するか）、`getClientConnectionStatuses`（クライアント配下の全接続＋最終同期ステータス）、`summarizeSyncStatuses`（DB行から healthy/error/pending を集計する純関数）。
- **Nango実装**: テナント別キー解決（SecretStore→フォールバックキーの順）、キー疎通確認（`pingNango`）、プロバイダカタログ・設定済み統合一覧。APIエンドポイント・タイムアウト値（10/15/30秒）は元実装のまま。
- **参照実装**: `MockIntegrationProvider`（インメモリ）。外部通信なしで connect → sync → poll → records → publish の一連の流れを再現できる。

## IntegrationProvider 契約

```ts
interface IntegrationProvider {
  connect(tenantId, params): Promise<ConnectSession | null>;          // OAuth接続セッション作成
  listConnections(tenantId?, integrationId?, clientId?): Promise<IntegrationConnection[]>;
  deleteConnection(tenantId, integrationId, connectionId): Promise<boolean>;
  triggerSync(tenantId, integrationId, connectionId, syncs?): Promise<boolean>;   // fire
  pollStatus(tenantId, integrationId, connectionId): Promise<SyncStatusInfo | null>; // poll
  fetchRecords<T>(tenantId, integrationId, connectionId, model, options?): Promise<{ records: T[]; next_cursor?: string }>;
  publish<T>(tenantId, integrationId, connectionId, { method?, endpoint, body? }): Promise<{ data: T; status: number } | null>;
}
```

規約: 失敗は throw ではなく `null` / `false` / 空配列で返す（元実装の防御的スタイル）。`pollStatus` は `{ status?: string }` を含むオブジェクトを返し、`success|SUCCESS` / `error|ERROR` だけが状態機械の終端。

### 使用例

```ts
import {
  NangoProvider, SyncEngine, NormalizerRegistry, createExampleRegistry,
  triggerAndWaitForSync, publishToMultiplePlatforms, getClientConnectionStatuses,
} from "@torihanaku/kit-integration-manager";

// 1) プロバイダ（Nango実装）— キーは設定から注入。process.env 直読みはしない
const provider = new NangoProvider({
  defaultSecretKey: config.nangoSecretKey,        // self-hosted等の全体キー（任意）
  secretStore: {                                   // テナント別キー（任意）
    get: async (tenantId) => await tenantSecrets.getNangoConfig(tenantId),
  },
});

// 2) OAuth接続 → fire-and-wait同期
const session = await provider.connect(tenantId, { end_user: { id: userEmail } });
const sync = await triggerAndWaitForSync(provider, tenantId, "slack", connectionId);

// 3) 正規化取り込み（保存先・同意ゲートは注入）
const engine = new SyncEngine({
  provider,
  registry: createExampleRegistry(),               // slack/email/GA4 の例を登録済み
  sink: {
    exists: async ({ scopeId, sourceType, externalId }) => db.sourceExists(...),
    insert: async (record) => db.insertSource(record),
  },
  consentGate: async ({ tenantId, record }) => consent.isGranted(tenantId, record.user),
});
await engine.syncAllConnections(tenantId, projectId, clientId);

// 4) マルチプラットフォーム発行
await publishToMultiplePlatforms(provider, tenantId, draft, [
  { platform: "slack", connectionId: "c1", slackChannel: "#marketing" },
  { platform: "wordpress", connectionId: "c2" },
], async (draft, platform) => db.markPublished(draft.id, platform));
```

## 注入ポイント

| 注入先 | 契約 | 元実装での実体 |
|---|---|---|
| `NangoProvider({ secretStore })` | `SecretStore.get(tenantId) → { secretKey, serverUrl?, enabled }` | `dd_nango_settings` テーブル + AES-256-GCM 復号（`@torihanaku/tenant-secrets` がこの契約を満たす。復号済み平文を返すこと） |
| `NangoProvider({ defaultSecretKey, defaultServerUrl })` | 文字列 | `NANGO_SECRET_KEY` / `NANGO_SERVER_URL` env |
| `NangoProvider({ fetch })` | `typeof fetch` | グローバル fetch（テスト・リトライ層の差し替え用） |
| `SyncEngine({ sink })` | `RecordSink.exists / insert` | Supabase `cockpit_project_sources` への upsert |
| `SyncEngine({ consentGate })` | `(ctx) => Promise<boolean>`（falseでスキップ） | Slack限定の同意チェック（feature flag + `slack_user_mapping` + 同意テーブル）。全統合・全レコードに一般化 |
| `SyncEngine({ registry })` | `NormalizerRegistry` | 固定の `SYNC_CONFIGS` マップ |
| `publishToPlatform(..., onPublished)` | `(draft, platform) => Promise<void>` | `dd_content_drafts` を published に更新 |
| 各オーケストレーション関数の第1引数 | `IntegrationProvider` | `nango-client.ts` 直 import |

## SQLスキーマ（参考: 元実装のテーブル）

このキット自体はDB非依存。元実装で対応していたテーブルを移植時の参考として記載する。

```sql
-- テナント別Nango設定（secret_key はアプリ層でAES-256-GCM暗号化して保存）
CREATE TABLE IF NOT EXISTS dd_nango_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL UNIQUE,
  secret_key TEXT NOT NULL DEFAULT '',   -- 暗号文（空=envフォールバックに委ねる）
  public_key TEXT NOT NULL DEFAULT '',
  server_url TEXT NOT NULL DEFAULT 'https://api.nango.dev',
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 接続の台帳（プロジェクト/スコープ単位・同期ステータスのキャッシュ）
CREATE TABLE IF NOT EXISTS cockpit_nango_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,              -- キットでは scope_id に一般化
  integration_id TEXT NOT NULL,          -- 例: "slack"
  connection_id TEXT NOT NULL,           -- 例: "client_{clientId}_{integrationId}"
  last_sync_at TIMESTAMPTZ,
  status TEXT,                           -- success | error | それ以外=pending
  record_count INTEGER DEFAULT 0
);

-- 正規化レコードの保存先（RecordSink の実体。NormalizedRecord と1:1）
CREATE TABLE IF NOT EXISTS cockpit_project_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,              -- = NormalizedRecord.scope_id
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  external_id TEXT,                      -- 重複排除キー
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, source_type, external_id)
);
```

## 落としたもの（と理由）

- **ノーマライザ9種**: document（google-drive/sharepoint）、Notion/Confluenceページ、チケット（jira/asana/linear）、Google Search Console、Google Ads キャンペーン、Meta Ads キャンペーン。→ レジストリ方式に置き換え、例として3種（チャット=slack/teams、メール=gmail/outlook、GA4レポート）のみ改名移植。必要になったら元の `server/lib/nango-sync.ts` の transform を `registry.register()` で復元できる。
- **`INTEGRATION_TO_SOURCE_TYPE` の残りマッピング**（hubspot/salesforce/github/zoom/youtube/instagram/mailchimp/wordpress 等）: レジストリ登録に統合されたため固定マップ自体を廃止。
- **HTTPルート層**（`routes/nango-integrations.ts` / `nango-settings.ts` / `integrations-crud.ts` / `integrations-oauth.ts` / `integrations-japan.ts` / `integrations-data/sync-connect.ts`）: 認証（requireRole）・監査ログ・Supabase 直参照に密結合の製品固有コード。再利用価値のある部分だけ移植 — sync-status 集計（#526）→ `summarizeSyncStatuses`、プロジェクト一括同期 → `triggerSyncBatch`、接続ID規約 → `connection-id.ts`。
- **Google Analytics / Google Sheets 直結 fetch**（`integrations-data/google-analytics.ts` / `google-sheets.ts`）: Nango を経由しない Google OAuth トークン直叩き＋トークンリフレッシュ＋Supabase config 保存で、統合「マネージャー」ではなく個別コネクタ。OAuth フロー汎用化は `oauth-manager` パッケージの領域。
- **キー暗号化の実装**（`lib/token.ts` AES-256-GCM、レガシー平文フォールバック）: `SecretStore` 注入に置換（`@torihanaku/tenant-secrets` が担当）。`describeNangoSecret`（last4表示）も secrets 側の関心のため落とした。
- **Slack同意ゲートの実装**（consent-guard + slack-user-mapping + feature flag 照会）: `ConsentGate` 述語の注入に一般化。
- **`BUILTIN_PROVIDERS` フォールバックカタログ・connect-url 生成**（#527）: 製品UI固有の12件ハードコード。
- **プロジェクト→クライアントの DB 解決**（`syncProjectConnections` 冒頭の cockpit_projects 参照）: 呼び出し側が接続リストを渡す `triggerSyncBatch` に一般化。
- **`dd_content_drafts` の published 更新**: `onPublished` コールバックに externalize。

## テスト

```bash
npx tsc --noEmit -p packages/kit-integration-manager/tsconfig.json
npx vitest run packages/kit-integration-manager   # 6ファイル / 68テスト
```

`MockIntegrationProvider` による connect→sync→poll→records の一気通貫シナリオ、fire-and-wait 状態機械（成功/失敗/タイムアウト/大文字ステータス）、ノーマライザレジストリ（登録/フォールバック/例3種）、発行フロー（6プラットフォーム＋onPublished）、Nango実装（SecretStore解決/クライアント絞り込み/APIリクエスト形状/障害時フォールバック）を検証。キー値はすべてフェイク。

## 出典

| 移植先 | 元ファイル（dev-dashboard-v2） |
|---|---|
| `src/providers/nango.ts` / `src/connection-id.ts` | `server/lib/nango-client.ts`（266行） |
| `src/operations.ts` / `src/publish.ts` | `server/lib/nango-operations.ts`（297行） |
| `src/normalizers.ts` / `src/sync-engine.ts` | `server/lib/nango-sync.ts`（350行） |
| `src/status-summary.ts` | `server/routes/nango-integrations.ts` の sync-status 集計（#526） |
| テスト | `tests/nango-operations.test.ts` を契約ベースに移植・拡張 |
