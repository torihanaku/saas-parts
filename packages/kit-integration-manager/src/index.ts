/**
 * @torihanaku/kit-integration-manager
 *
 * 外部SaaS統合マネージャー: テナント別接続管理 → fire-and-wait同期（ポーリング）
 * → データ正規化 → マルチプラットフォーム発行 → ヘルスチェック。
 * 出典: 実運用SaaS の nango-* モジュール群（詳細は README）。
 */

// コア型・プロバイダ契約
export type {
  IntegrationConnection,
  IntegrationRecord,
  ConnectSessionParams,
  ConnectSession,
  FetchRecordsOptions,
  FetchRecordsResult,
  PublishRequest,
  PublishResponse,
  SyncStatusInfo,
  IntegrationProvider,
  TenantIntegrationConfig,
  SecretStore,
  ConsentGate,
} from "./types";

// 接続ID規約
export { buildConnectionId, extractClientId, isClientConnection } from "./connection-id";

// Nango実装（注入可能な一プロバイダ）
export {
  NangoProvider,
  pingNango,
  DEFAULT_NANGO_SERVER_URL,
  type NangoProviderOptions,
} from "./providers/nango";

// 同期オーケストレーション（fire-and-wait・バッチ・ヘルス）
export {
  triggerAndWaitForSync,
  triggerSyncBatch,
  validateConnection,
  getClientConnectionStatuses,
  resolveConnectionId,
  type TriggerResult,
  type ConnectionStatus,
} from "./operations";

// マルチプラットフォーム発行
export {
  buildPublishPayload,
  publishToPlatform,
  publishToMultiplePlatforms,
  type PublishPlatform,
  type PublishTarget,
  type PublishResult,
  type ContentDraft,
  type OnPublished,
} from "./publish";

// 正規化レジストリ
export {
  NormalizerRegistry,
  createExampleRegistry,
  normalizeChatMessage,
  normalizeEmail,
  normalizeGa4Report,
  normalizeGeneric,
  type NormalizedRecord,
  type Normalizer,
  type NormalizerConfig,
} from "./normalizers";

// 同期エンジン
export { SyncEngine, type SyncEngineOptions, type SyncOutcome, type RecordSink } from "./sync-engine";

// インメモリ参照実装（テスト・プロトタイプ用）
export { MockIntegrationProvider } from "./mock-provider";

// ステータス集計
export {
  summarizeSyncStatuses,
  type ConnectionSyncRow,
  type NormalizedConnectionSyncRow,
  type SyncStatusSummary,
} from "./status-summary";
