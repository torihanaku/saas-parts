/**
 * 同期エンジン: プロバイダからレコードを取得し、正規化して保存する。
 *
 * 出典: 実運用SaaS server/lib/nango-sync.ts（syncIntegrationRecords /
 * syncConnection / syncAllConnections / getIntegrationStatus）。
 * 汎用化ポイント:
 *   - Supabase 直書き（cockpit_project_sources）→ RecordSink 注入（exists + insert）
 *   - Slack限定の同意チェック（feature flag + ユーザーマッピング）→ ConsentGate 注入
 *     （全統合の全レコードに対して呼ばれる。false でスキップ）
 *   - 固定 SYNC_CONFIGS → NormalizerRegistry 注入
 */
import type { ConsentGate, IntegrationProvider } from "./types";
import { NormalizerRegistry, type NormalizedRecord } from "./normalizers";

// ─── 型 ──────────────────────────────────────────────────────────────────────

export interface SyncOutcome {
  integration: string;
  connectionId: string;
  recordsSynced: number;
  error?: string;
}

/** 正規化済みレコードの保存先（重複判定 + 挿入） */
export interface RecordSink {
  /** external_id ベースの重複判定。true なら insert をスキップ */
  exists(query: { scopeId: string; sourceType: string; externalId: string }): Promise<boolean>;
  insert(record: NormalizedRecord): Promise<void>;
}

export interface SyncEngineOptions {
  provider: IntegrationProvider;
  sink: RecordSink;
  /** 省略時は空レジストリ（全統合が汎用フォールバック） */
  registry?: NormalizerRegistry;
  /** 同意ゲート。省略時は全レコード取り込み */
  consentGate?: ConsentGate;
  /** 1回の同期で取得するレコード数（既定: 50 — 元実装の値） */
  fetchLimit?: number;
}

// ─── エンジン ────────────────────────────────────────────────────────────────

export class SyncEngine {
  private readonly provider: IntegrationProvider;
  private readonly sink: RecordSink;
  private readonly registry: NormalizerRegistry;
  private readonly consentGate?: ConsentGate;
  private readonly fetchLimit: number;

  constructor(options: SyncEngineOptions) {
    this.provider = options.provider;
    this.sink = options.sink;
    this.registry = options.registry ?? new NormalizerRegistry();
    this.consentGate = options.consentGate;
    this.fetchLimit = options.fetchLimit ?? 50;
  }

  /** 1接続を1スコープ（元: project）へ同期する */
  async syncConnection(
    tenantId: string,
    integrationId: string,
    connectionId: string,
    scopeId: string,
  ): Promise<SyncOutcome> {
    const { model, sourceType, normalize } = this.registry.resolve(integrationId);
    try {
      const { records } = await this.provider.fetchRecords(
        tenantId,
        integrationId,
        connectionId,
        model,
        { limit: this.fetchLimit },
      );
      let synced = 0;

      for (const record of records) {
        const raw = record as Record<string, unknown>;

        // 同意ゲート（元実装: Slack取り込みのみユーザー同意を照会。注入式に一般化）
        if (this.consentGate) {
          const granted = await this.consentGate({ tenantId, integrationId, record: raw });
          if (!granted) continue;
        }

        const normalized = normalize(raw);
        if (!normalized) continue;
        normalized.scope_id = scopeId;
        normalized.source_type = sourceType;

        // Upsert: external_id が既存ならスキップ（元実装のまま）
        if (normalized.external_id) {
          const exists = await this.sink.exists({
            scopeId,
            sourceType,
            externalId: normalized.external_id,
          });
          if (exists) continue;
        }

        await this.sink.insert(normalized);
        synced++;
      }

      return { integration: integrationId, connectionId, recordsSynced: synced };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { integration: integrationId, connectionId, recordsSynced: 0, error: msg };
    }
  }

  /** 全接続を順次同期する（clientId で絞り込み可能） */
  async syncAllConnections(
    tenantId: string,
    scopeId: string,
    clientId?: string,
  ): Promise<SyncOutcome[]> {
    const connections = await this.provider.listConnections(tenantId, undefined, clientId);
    if (connections.length === 0) return [];
    const results: SyncOutcome[] = [];

    for (const conn of connections) {
      const result = await this.syncConnection(
        tenantId,
        conn.provider_config_key,
        conn.connection_id,
        scopeId,
      );
      results.push(result);
    }

    return results;
  }

  /** レジストリ登録済みの統合種別ごとに接続状況を返す */
  async getIntegrationStatus(
    tenantId?: string,
    clientId?: string,
  ): Promise<Array<{
    integration: string;
    sourceType: string;
    connected: boolean;
    connectionCount: number;
  }>> {
    const connections = await this.provider.listConnections(tenantId, undefined, clientId);
    const connByIntegration = new Map<string, number>();
    for (const c of connections) {
      const count = connByIntegration.get(c.provider_config_key) || 0;
      connByIntegration.set(c.provider_config_key, count + 1);
    }

    return this.registry.list().map((integration) => ({
      integration,
      sourceType: this.registry.resolve(integration).sourceType,
      connected: connByIntegration.has(integration),
      connectionCount: connByIntegration.get(integration) || 0,
    }));
  }
}
