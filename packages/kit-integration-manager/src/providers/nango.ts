/**
 * Nango（https://nango.dev）ベースの IntegrationProvider 実装。
 *
 * 出典: dev-dashboard-v2 server/lib/nango-client.ts（実働コード）。
 * 汎用化ポイント:
 *   - テナント別キーの取得は SecretStore 注入（元: dd_nango_settings + AES-256-GCM 復号）
 *   - 既定キー/URL はコンストラクタ注入（元: NANGO_SECRET_KEY / NANGO_SERVER_URL env）
 *   - fetch 注入（テスト・リトライ層の差し替え用）
 *
 * API呼び出し（エンドポイント・ヘッダー・タイムアウト値）は元実装のまま。
 */
import type {
  ConnectSession,
  ConnectSessionParams,
  FetchRecordsOptions,
  FetchRecordsResult,
  IntegrationConnection,
  IntegrationProvider,
  IntegrationRecord,
  PublishRequest,
  PublishResponse,
  SecretStore,
  SyncStatusInfo,
} from "../types";
import { isClientConnection } from "../connection-id";

export const DEFAULT_NANGO_SERVER_URL = "https://api.nango.dev";

export interface NangoProviderOptions {
  /** テナント設定が無い場合のフォールバックキー（self-hosted等の全体キー） */
  defaultSecretKey?: string;
  /** フォールバックのNangoサーバーURL（既定: https://api.nango.dev） */
  defaultServerUrl?: string;
  /** テナント別クレデンシャルの読み出し口 */
  secretStore?: SecretStore;
  /** fetch 実装（既定: globalThis.fetch） */
  fetch?: typeof fetch;
}

interface ResolvedConfig {
  secretKey: string;
  serverUrl: string;
}

/**
 * 候補キーの疎通確認。安価なNangoエンドポイントを叩いて検証する。
 * （設定画面の「キーを検証」ボタン用）
 */
export async function pingNango(
  secretKey: string,
  serverUrl: string = DEFAULT_NANGO_SERVER_URL,
  fetchFn: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!secretKey) return { ok: false, status: 0, error: "secret_key is required" };
  try {
    const res = await fetchFn(`${serverUrl}/integrations`, {
      method: "GET",
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    });
    if (res.ok) return { ok: true, status: res.status };
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: body.slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : "network error" };
  }
}

export class NangoProvider implements IntegrationProvider {
  private readonly defaultSecretKey: string;
  private readonly defaultServerUrl: string;
  private readonly secretStore?: SecretStore;
  private readonly fetchFn: typeof fetch;

  constructor(options: NangoProviderOptions = {}) {
    this.defaultSecretKey = options.defaultSecretKey ?? "";
    this.defaultServerUrl = options.defaultServerUrl ?? DEFAULT_NANGO_SERVER_URL;
    this.secretStore = options.secretStore;
    this.fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  /** フォールバックキーが設定されているか（テナント設定なしでも動くか） */
  isConfigured(): boolean {
    return !!this.defaultSecretKey;
  }

  /**
   * テナント設定 → フォールバックキーの順でクレデンシャルを解決する。
   * どちらも無ければ null（呼び出し側は 501 等で応答する想定）。
   */
  async resolveConfig(tenantId?: string): Promise<ResolvedConfig | null> {
    if (tenantId && this.secretStore) {
      const s = await this.secretStore.get(tenantId);
      if (s?.enabled && s.secretKey) {
        return { secretKey: s.secretKey, serverUrl: s.serverUrl || DEFAULT_NANGO_SERVER_URL };
      }
    }
    if (this.defaultSecretKey) {
      return { secretKey: this.defaultSecretKey, serverUrl: this.defaultServerUrl };
    }
    return null;
  }

  private headers(cfg: ResolvedConfig): Record<string, string> {
    return { Authorization: `Bearer ${cfg.secretKey}`, "Content-Type": "application/json" };
  }

  // ─── IntegrationProvider 実装 ─────────────────────────────────────────────

  async connect(tenantId: string, params: ConnectSessionParams): Promise<ConnectSession | null> {
    const cfg = await this.resolveConfig(tenantId);
    if (!cfg) return null;
    try {
      const res = await this.fetchFn(`${cfg.serverUrl}/connect/sessions`, {
        method: "POST",
        headers: this.headers(cfg),
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      return (await res.json()) as ConnectSession;
    } catch {
      return null;
    }
  }

  async listConnections(
    tenantId?: string,
    integrationId?: string,
    clientId?: string,
  ): Promise<IntegrationConnection[]> {
    const cfg = await this.resolveConfig(tenantId);
    if (!cfg) return [];
    const params = new URLSearchParams();
    if (integrationId) params.set("integrationIds", integrationId);
    try {
      const res = await this.fetchFn(`${cfg.serverUrl}/connections?${params}`, {
        headers: this.headers(cfg),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { connections: IntegrationConnection[] };
      const all = data.connections || [];
      if (clientId) return all.filter((c) => isClientConnection(c.connection_id, clientId));
      return all;
    } catch {
      return [];
    }
  }

  async deleteConnection(
    tenantId: string,
    integrationId: string,
    connectionId: string,
  ): Promise<boolean> {
    const cfg = await this.resolveConfig(tenantId);
    if (!cfg) return false;
    try {
      const res = await this.fetchFn(
        `${cfg.serverUrl}/connections/${connectionId}?provider_config_key=${integrationId}`,
        { method: "DELETE", headers: this.headers(cfg), signal: AbortSignal.timeout(10000) },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async triggerSync(
    tenantId: string,
    integrationId: string,
    connectionId: string,
    syncs?: string[],
  ): Promise<boolean> {
    const cfg = await this.resolveConfig(tenantId);
    if (!cfg) return false;
    try {
      const res = await this.fetchFn(`${cfg.serverUrl}/syncs/trigger`, {
        method: "POST",
        headers: this.headers(cfg),
        body: JSON.stringify({
          provider_config_key: integrationId,
          connection_id: connectionId,
          syncs,
        }),
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async pollStatus(
    tenantId: string,
    integrationId: string,
    connectionId: string,
  ): Promise<SyncStatusInfo | null> {
    const cfg = await this.resolveConfig(tenantId);
    if (!cfg) return null;
    try {
      const res = await this.fetchFn(`${cfg.serverUrl}/syncs/status`, {
        method: "POST",
        headers: this.headers(cfg),
        body: JSON.stringify({ provider_config_key: integrationId, connection_id: connectionId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      return (await res.json()) as SyncStatusInfo;
    } catch {
      return null;
    }
  }

  async fetchRecords<T = IntegrationRecord>(
    tenantId: string,
    integrationId: string,
    connectionId: string,
    model: string,
    options?: FetchRecordsOptions,
  ): Promise<FetchRecordsResult<T>> {
    const cfg = await this.resolveConfig(tenantId);
    if (!cfg) return { records: [] };
    const params = new URLSearchParams({ model });
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    try {
      const res = await this.fetchFn(`${cfg.serverUrl}/records?${params}`, {
        headers: {
          ...this.headers(cfg),
          "Connection-Id": connectionId,
          "Provider-Config-Key": integrationId,
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { records: [] };
      return (await res.json()) as FetchRecordsResult<T>;
    } catch {
      return { records: [] };
    }
  }

  async publish<T = unknown>(
    tenantId: string,
    integrationId: string,
    connectionId: string,
    request: PublishRequest,
  ): Promise<PublishResponse<T> | null> {
    const cfg = await this.resolveConfig(tenantId);
    if (!cfg) return null;
    try {
      const res = await this.fetchFn(`${cfg.serverUrl}/proxy/${request.endpoint}`, {
        method: request.method ?? "POST",
        headers: {
          ...this.headers(cfg),
          "Connection-Id": connectionId,
          "Provider-Config-Key": integrationId,
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as T;
      return { data: body, status: res.status };
    } catch {
      return null;
    }
  }

  // ─── Nango固有の補助API（契約外だが有用なので保持） ────────────────────────

  /** Nangoのプロバイダカタログ（700+）の取得 */
  async listProviders(
    tenantId?: string,
  ): Promise<Array<{ name: string; display_name?: string; categories?: string[]; docs?: string }>> {
    const cfg = await this.resolveConfig(tenantId);
    if (!cfg) return [];
    try {
      const res = await this.fetchFn(`${cfg.serverUrl}/providers`, {
        headers: this.headers(cfg),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        data?: Array<{ name: string; display_name?: string; categories?: string[] }>;
      };
      return data.data || [];
    } catch {
      return [];
    }
  }

  /** Nango側で設定済みのインテグレーション一覧 */
  async listIntegrations(tenantId?: string): Promise<Array<{ unique_key: string; provider: string }>> {
    const cfg = await this.resolveConfig(tenantId);
    if (!cfg) return [];
    try {
      const res = await this.fetchFn(`${cfg.serverUrl}/integrations`, {
        headers: this.headers(cfg),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { configs?: Array<{ unique_key: string; provider: string }> };
      return data.configs || [];
    } catch {
      return [];
    }
  }
}
