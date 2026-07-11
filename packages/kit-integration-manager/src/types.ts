/**
 * 外部SaaS統合マネージャーのコア型定義。
 *
 * すべての操作は provider-agnostic な `IntegrationProvider` 契約を通す。
 * Nango 実装（providers/nango.ts）はこの契約を満たす注入可能な一実装。
 */

// ─── 接続・レコード ──────────────────────────────────────────────────────────

/** 外部SaaSへの1接続（プロバイダ側で管理されるOAuth接続など） */
export interface IntegrationConnection {
  id: number | string;
  connection_id: string;
  /** 統合の識別子（例: "slack", "google-analytics"） */
  provider_config_key: string;
  provider: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

/** プロバイダから取得した生レコード */
export interface IntegrationRecord {
  id: string;
  [key: string]: unknown;
}

// ─── 接続セッション ──────────────────────────────────────────────────────────

/** OAuth接続セッション作成パラメータ */
export interface ConnectSessionParams {
  end_user: { id: string; email?: string; display_name?: string };
  organization?: { id: string; display_name?: string };
  allowed_integrations?: string[];
}

/** フロントエンドに渡す接続セッショントークン */
export interface ConnectSession {
  token: string;
}

// ─── レコード取得 ────────────────────────────────────────────────────────────

export interface FetchRecordsOptions {
  limit?: number;
  cursor?: string;
}

export interface FetchRecordsResult<T> {
  records: T[];
  next_cursor?: string;
}

// ─── 発行（publish） ─────────────────────────────────────────────────────────

/** プロバイダ経由の認証付きAPIリクエスト（プロキシ発行） */
export interface PublishRequest {
  /** HTTPメソッド（既定: POST） */
  method?: string;
  /** プロバイダ側プロキシに渡すエンドポイント（例: "/chat.postMessage"） */
  endpoint: string;
  body?: Record<string, unknown>;
}

export interface PublishResponse<T = unknown> {
  data: T;
  status: number;
}

// ─── 同期ステータス ──────────────────────────────────────────────────────────

/** プロバイダが返す同期ステータス（形はプロバイダ依存。status フィールドだけ規約） */
export interface SyncStatusInfo {
  status?: string;
  [key: string]: unknown;
}

// ─── プロバイダ契約 ──────────────────────────────────────────────────────────

/**
 * 外部SaaS統合プロバイダの契約。
 *
 * Nango / Merge / 自前OAuth基盤など、統合基盤をこのインターフェースで抽象化する。
 * すべてのメソッドは tenantId を受け取り、テナントごとのクレデンシャル解決は
 * 実装側（SecretStore 注入）の責務とする。
 */
export interface IntegrationProvider {
  /** OAuth接続セッションを作成しトークンを返す（未設定などで失敗時は null） */
  connect(tenantId: string, params: ConnectSessionParams): Promise<ConnectSession | null>;

  /** 接続一覧（integrationId / clientId で絞り込み可能） */
  listConnections(
    tenantId?: string,
    integrationId?: string,
    clientId?: string,
  ): Promise<IntegrationConnection[]>;

  /** 接続の削除 */
  deleteConnection(tenantId: string, integrationId: string, connectionId: string): Promise<boolean>;

  /** 同期をトリガー（fire） */
  triggerSync(
    tenantId: string,
    integrationId: string,
    connectionId: string,
    syncs?: string[],
  ): Promise<boolean>;

  /** 同期ステータスの取得（poll） */
  pollStatus(
    tenantId: string,
    integrationId: string,
    connectionId: string,
  ): Promise<SyncStatusInfo | null>;

  /** 同期済みレコードの取得 */
  fetchRecords<T = IntegrationRecord>(
    tenantId: string,
    integrationId: string,
    connectionId: string,
    model: string,
    options?: FetchRecordsOptions,
  ): Promise<FetchRecordsResult<T>>;

  /** 認証付きAPIリクエストの発行（コンテンツ投稿等）。失敗時は null */
  publish<T = unknown>(
    tenantId: string,
    integrationId: string,
    connectionId: string,
    request: PublishRequest,
  ): Promise<PublishResponse<T> | null>;
}

// ─── クレデンシャル注入 ──────────────────────────────────────────────────────

/** テナントごとの統合クレデンシャル（復号済みの平文） */
export interface TenantIntegrationConfig {
  secretKey: string;
  serverUrl?: string;
  enabled: boolean;
}

/**
 * テナント別クレデンシャルの読み出し口。
 * 暗号化保存・復号は実装側の責務（`@torihanaku/tenant-secrets` がこの契約を満たす）。
 */
export interface SecretStore {
  get(tenantId: string): Promise<TenantIntegrationConfig | null>;
}

// ─── 同意ゲート ──────────────────────────────────────────────────────────────

/**
 * 取り込み時の同意（consent）ゲート。false を返したレコードは同期をスキップする。
 * 元実装では Slack 取り込みのみユーザー同意テーブルを照会していた。
 */
export type ConsentGate = (ctx: {
  tenantId: string;
  integrationId: string;
  record: Record<string, unknown>;
}) => Promise<boolean>;
