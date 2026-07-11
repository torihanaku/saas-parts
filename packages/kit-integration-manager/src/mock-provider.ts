/**
 * IntegrationProvider のインメモリ参照実装（テスト・プロトタイプ用）。
 * 実プロバイダ（NangoProvider 等）と同じ契約で、外部通信なしに
 * connect → sync → poll → records → publish の一連の流れを再現できる。
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
  SyncStatusInfo,
} from "./types";
import { isClientConnection } from "./connection-id";

export class MockIntegrationProvider implements IntegrationProvider {
  /** プロバイダ側に存在する接続 */
  connections: IntegrationConnection[] = [];
  /** モデル名 → 返すレコード */
  recordsByModel = new Map<string, IntegrationRecord[]>();
  /** pollStatus が順に返すステータス（尽きたら { status: "running" }） */
  statusSequence: Array<SyncStatusInfo | null> = [];
  /** triggerSync を失敗させる */
  failTrigger = false;
  /** publish の戻り値（null で失敗を再現） */
  publishResult: PublishResponse | null = { data: {}, status: 200 };

  readonly triggerCalls: Array<{ tenantId: string; integrationId: string; connectionId: string; syncs?: string[] }> = [];
  readonly publishCalls: Array<{ tenantId: string; integrationId: string; connectionId: string; request: PublishRequest }> = [];

  addConnection(connectionId: string, integrationId: string): void {
    this.connections.push({
      id: this.connections.length + 1,
      connection_id: connectionId,
      provider_config_key: integrationId,
      provider: integrationId,
      created_at: new Date().toISOString(),
    });
  }

  async connect(_tenantId: string, params: ConnectSessionParams): Promise<ConnectSession | null> {
    return { token: `mock_session_${params.end_user.id}` };
  }

  async listConnections(
    _tenantId?: string,
    integrationId?: string,
    clientId?: string,
  ): Promise<IntegrationConnection[]> {
    let all = this.connections;
    if (integrationId) all = all.filter((c) => c.provider_config_key === integrationId);
    if (clientId) all = all.filter((c) => isClientConnection(c.connection_id, clientId));
    return all;
  }

  async deleteConnection(
    _tenantId: string,
    _integrationId: string,
    connectionId: string,
  ): Promise<boolean> {
    const before = this.connections.length;
    this.connections = this.connections.filter((c) => c.connection_id !== connectionId);
    return this.connections.length < before;
  }

  async triggerSync(
    tenantId: string,
    integrationId: string,
    connectionId: string,
    syncs?: string[],
  ): Promise<boolean> {
    this.triggerCalls.push({ tenantId, integrationId, connectionId, syncs });
    return !this.failTrigger;
  }

  async pollStatus(
    _tenantId: string,
    _integrationId: string,
    _connectionId: string,
  ): Promise<SyncStatusInfo | null> {
    if (this.statusSequence.length > 0) return this.statusSequence.shift() ?? null;
    return { status: "running" };
  }

  async fetchRecords<T = IntegrationRecord>(
    _tenantId: string,
    _integrationId: string,
    _connectionId: string,
    model: string,
    options?: FetchRecordsOptions,
  ): Promise<FetchRecordsResult<T>> {
    const records = (this.recordsByModel.get(model) ?? []) as T[];
    const limit = options?.limit ?? records.length;
    return { records: records.slice(0, limit) };
  }

  async publish<T = unknown>(
    tenantId: string,
    integrationId: string,
    connectionId: string,
    request: PublishRequest,
  ): Promise<PublishResponse<T> | null> {
    this.publishCalls.push({ tenantId, integrationId, connectionId, request });
    return this.publishResult as PublishResponse<T> | null;
  }
}
