/**
 * 同期ステータスの集計（ヘルスチェック用サマリ）。
 *
 * 出典: 実運用SaaS server/routes/nango-integrations.ts の
 * GET /api/nango/sync-status（#526）。DB行の形をそのまま純関数化した。
 * 状態機械: status "success" → healthy / "error" → error / それ以外・未設定 → pending。
 */

export interface ConnectionSyncRow {
  id: string;
  integration_id: string;
  connection_id: string;
  /** 元: project_id */
  scope_id?: string;
  last_sync_at?: string | null;
  status?: string | null;
  record_count?: number | null;
}

export interface NormalizedConnectionSyncRow {
  id: string;
  integration_id: string;
  connection_id: string;
  scope_id: string | null;
  last_sync_at: string | null;
  status: string;
  record_count: number;
}

export interface SyncStatusSummary {
  connections: NormalizedConnectionSyncRow[];
  summary: { total: number; healthy: number; error: number; pending: number };
}

/** 接続行を正規化しつつ healthy/error/pending を集計する（元実装のまま） */
export function summarizeSyncStatuses(rows: ConnectionSyncRow[]): SyncStatusSummary {
  const total = rows.length;
  let healthy = 0;
  let error = 0;
  let pending = 0;

  const normalized = rows.map((c) => {
    const status = c.status ?? "pending";
    if (status === "success") healthy++;
    else if (status === "error") error++;
    else pending++;
    return {
      id: c.id,
      integration_id: c.integration_id,
      connection_id: c.connection_id,
      scope_id: c.scope_id ?? null,
      last_sync_at: c.last_sync_at ?? null,
      status,
      record_count: c.record_count ?? 0,
    };
  });

  return {
    connections: normalized,
    summary: { total, healthy, error, pending },
  };
}
