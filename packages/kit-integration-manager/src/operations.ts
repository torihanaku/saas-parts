/**
 * 高レベル同期オーケストレーション（provider-agnostic）。
 *
 * 出典: dev-dashboard-v2 server/lib/nango-operations.ts。
 * fire-and-wait のポーリングロジックと成功/失敗/タイムアウトの状態機械は元実装のまま。
 * 汎用化ポイント:
 *   - nango-client 直import → IntegrationProvider 注入
 *   - プロジェクト→接続の Supabase 参照 → 呼び出し側が接続リストを渡す
 */
import type { IntegrationProvider, SyncStatusInfo } from "./types";
import { buildConnectionId } from "./connection-id";

// ─── 型 ──────────────────────────────────────────────────────────────────────

export interface TriggerResult {
  integrationId: string;
  connectionId: string;
  ok: boolean;
}

export interface ConnectionStatus {
  integrationId: string;
  connectionId: string;
  connected: boolean;
  lastSyncStatus?: SyncStatusInfo | null;
}

// ─── fire-and-wait 同期 ──────────────────────────────────────────────────────

/**
 * 同期をトリガーし、完了（またはタイムアウト）までポーリングして待つ。
 *
 * 状態機械（元実装のまま）:
 *   - trigger 失敗            → { ok: false }
 *   - status success/SUCCESS  → { ok: true, status }
 *   - status error/ERROR      → { ok: false, status }
 *   - 期限超過                → { ok: false, status: "timeout" }
 *
 * @param options.pollIntervalMs ポーリング間隔（既定: 2,000ms）
 * @param options.timeoutMs      最大待機時間（既定: 30,000ms）
 */
export async function triggerAndWaitForSync(
  provider: IntegrationProvider,
  tenantId: string,
  integrationId: string,
  connectionId: string,
  syncs?: string[],
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status?: unknown }> {
  const { pollIntervalMs = 2_000, timeoutMs = 30_000 } = options;

  const triggered = await provider.triggerSync(tenantId, integrationId, connectionId, syncs);
  if (!triggered) return { ok: false };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const status = await provider.pollStatus(tenantId, integrationId, connectionId);
    const s = status as { status?: string } | null;
    if (s?.status === "success" || s?.status === "SUCCESS") return { ok: true, status };
    if (s?.status === "error" || s?.status === "ERROR") return { ok: false, status };
  }

  return { ok: false, status: "timeout" };
}

// ─── バッチトリガー ──────────────────────────────────────────────────────────

/**
 * 複数接続の同期を並列トリガーする。
 * 元実装の syncProjectConnections から、プロジェクト→接続の DB 参照を剥がしたもの。
 * 呼び出し側が（自前のテーブル等から）接続リストを解決して渡す。
 */
export async function triggerSyncBatch(
  provider: IntegrationProvider,
  tenantId: string,
  connections: Array<{ integrationId: string; connectionId: string }>,
): Promise<{ total: number; succeeded: number; results: TriggerResult[] }> {
  if (!connections.length) {
    return { total: 0, succeeded: 0, results: [] };
  }

  const results: TriggerResult[] = await Promise.all(
    connections.map(async (c) => {
      const ok = await provider.triggerSync(tenantId, c.integrationId, c.connectionId);
      return { integrationId: c.integrationId, connectionId: c.connectionId, ok };
    }),
  );

  return {
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    results,
  };
}

// ─── 接続ヘルス ──────────────────────────────────────────────────────────────

/** 接続がプロバイダ側に存在するか（到達可能か）を検証する */
export async function validateConnection(
  provider: IntegrationProvider,
  tenantId: string,
  integrationId: string,
  connectionId: string,
): Promise<boolean> {
  const connections = await provider.listConnections(tenantId, integrationId);
  return connections.some((c) => c.connection_id === connectionId);
}

/** クライアント配下の全接続について、最終同期ステータス付きのサマリを返す */
export async function getClientConnectionStatuses(
  provider: IntegrationProvider,
  tenantId: string,
  clientId: string,
): Promise<ConnectionStatus[]> {
  const connections = await provider.listConnections(tenantId, undefined, clientId);
  return Promise.all(
    connections.map(async (c) => {
      const lastSyncStatus = await provider
        .pollStatus(tenantId, c.provider_config_key, c.connection_id)
        .catch(() => null);
      return {
        integrationId: c.provider_config_key,
        connectionId: c.connection_id,
        connected: true,
        lastSyncStatus,
      };
    }),
  );
}

// ─── 接続ID解決 ──────────────────────────────────────────────────────────────

/** クライアント+統合から標準命名 `client_{clientId}_{integrationId}` の接続IDを得る */
export function resolveConnectionId(clientId: string, integrationId: string): string {
  return buildConnectionId(clientId, integrationId);
}
