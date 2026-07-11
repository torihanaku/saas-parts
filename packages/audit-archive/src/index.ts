/**
 * Audit-event cold archival job (scheduling-agnostic).
 *
 * Rules (ported from the original daily job):
 * - Pull events occurred_at < retention cutoff (default 1 year) that are not
 *   yet archived
 * - Group by tenant_id, year, month
 * - Upload as JSONL to <tenant_id>/<year>/<month>/events_<timestamp>.jsonl
 * - Mark each event archived (with its archive path) on success
 *
 * Storage and the event source are injected as structural interfaces — no
 * cloud SDK imports, no env reads. Wire the exported function into your
 * scheduler of choice (e.g. @torihanaku/job-scheduler) at the call site;
 * this package deliberately does not import one.
 */

export interface ArchivableAuditEvent {
  id: string;
  tenant_id: string;
  /** ISO-8601 timestamp of when the event occurred. */
  occurred_at: string;
  [key: string]: unknown;
}

/** 監査イベントの取得元＋アーカイブ済みマーキング（元実装では Supabase PostgREST）。 */
export interface AuditEventSource {
  /**
   * occurred_at < cutoffIso かつ未アーカイブのイベントを最大 limit 件返す。
   * （元実装のクエリ: `occurred_at=lt.<cutoff>&archived_to_gcs=eq.false&limit=1000`）
   */
  fetchUnarchived(cutoffIso: string, limit: number): Promise<ArchivableAuditEvent[]>;
  /** アーカイブ成功後にイベントへ archived フラグと保存先パスを記録する。 */
  markArchived(eventId: string, archivePath: string): Promise<void>;
}

/** アーカイブ先オブジェクトストレージ（GCS/S3/ローカル等）。 */
export interface ObjectStorage {
  put(path: string, content: string): Promise<void>;
}

export interface ArchiveLogger {
  info(scope: string, message: unknown): void;
  error(scope: string, error: Error): void;
}

export interface ArchiveAuditEventsOptions {
  source: AuditEventSource;
  /**
   * null を渡すとスキップ（元実装の「GCS_AUDIT_ARCHIVE_BUCKET 未設定なら skip」
   * に相当。未設定環境でもジョブ登録自体は無害にしたいときに使う）。
   */
  storage: ObjectStorage | null;
  logger?: ArchiveLogger;
  /** 保持期間（年）。これより古いイベントが対象。既定 1。 */
  retentionYears?: number;
  /** 1回の実行で取得する最大件数。既定 1000。 */
  batchLimit?: number;
  /** 時刻源（テスト用）。省略時 `() => new Date()`。 */
  now?: () => Date;
}

export interface ArchiveAuditEventsResult {
  /** storage 未設定でスキップした場合 true。 */
  skipped: boolean;
  /** アーカイブしたイベント数。 */
  archivedCount: number;
  /** 書き出した JSONL ファイル数（tenant/year/month グループ数）。 */
  groupCount: number;
}

const SCOPE = "job.archive-audit-events";

const noopLogger: ArchiveLogger = {
  info: () => undefined,
  error: () => undefined,
};

/**
 * Archive audit events older than the retention window to object storage.
 *
 * Errors are caught and logged (never thrown) so a failing run does not crash
 * the surrounding scheduler — parity with the original job.
 */
export async function archiveAuditEvents(
  options: ArchiveAuditEventsOptions
): Promise<ArchiveAuditEventsResult> {
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? (() => new Date());
  const retentionYears = options.retentionYears ?? 1;
  const batchLimit = options.batchLimit ?? 1000;

  if (!options.storage) {
    logger.info(SCOPE, "Skipping: archive storage not configured");
    return { skipped: true, archivedCount: 0, groupCount: 0 };
  }
  const storage = options.storage;

  const startTime = now().getTime();
  const cutoffDate = now();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - retentionYears);
  const cutoff = cutoffDate.toISOString();

  let archivedCount = 0;
  let groupCount = 0;

  try {
    // 1. Fetch old events that are not yet archived
    const events = await options.source.fetchUnarchived(cutoff, batchLimit);

    if (events.length === 0) {
      logger.info(SCOPE, "No events to archive");
      return { skipped: false, archivedCount: 0, groupCount: 0 };
    }

    logger.info(SCOPE, `Found ${events.length} events to archive`);

    // 2. Group by tenant, year, month
    const groups: Record<string, ArchivableAuditEvent[]> = {};
    for (const ev of events) {
      const date = new Date(ev.occurred_at);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const key = `${ev.tenant_id}/${year}/${month}`;
      (groups[key] ??= []).push(ev);
    }

    for (const [key, groupEvents] of Object.entries(groups)) {
      // 3. Prepare JSONL
      const jsonl = groupEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";

      // Use timestamped file to avoid collision and allow easy parallel runs
      const timestamp = now().toISOString().replace(/[:.]/g, "-");
      const runFileName = `${key}/events_${timestamp}.jsonl`;

      await storage.put(runFileName, jsonl);

      // 4. Update status in the source store
      for (const ev of groupEvents) {
        await options.source.markArchived(ev.id, runFileName);
      }

      archivedCount += groupEvents.length;
      groupCount += 1;

      logger.info(SCOPE, {
        event: "audit_archived",
        tenant_id: key.split("/")[0],
        path: runFileName,
        count: groupEvents.length,
        duration_ms: now().getTime() - startTime,
      });
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error(SCOPE, error);
  }

  return { skipped: false, archivedCount, groupCount };
}
