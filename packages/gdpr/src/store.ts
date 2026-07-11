/**
 * GdprStore — persistence boundary for GDPR deletion/export.
 * The source talked to Supabase REST directly (fetch + supabasePatch);
 * here every data access is an injected interface. The in-memory
 * implementation is a reference for tests / local development.
 */

export interface GdprStoreResult {
  ok: boolean;
  error?: string;
}

/**
 * Result of a cascade DELETE on one table.
 * - "deleted": rows removed (count of removed rows)
 * - "table-missing": table does not exist — the executor logs "skipped"
 *   (source: HTTP 404/406 or "does not exist" body)
 * - "error": any other failure (executor logs "error" with detail)
 */
export type DeleteRowsOutcome =
  | { kind: "deleted"; count: number }
  | { kind: "table-missing"; detail: string }
  | { kind: "error"; detail: string };

/** Pending deletion request row (source: `dashboard_deletion_requests`). */
export interface DeletionRequest {
  id: string;
  user_id: string;
  email: string;
  status: string;
  /** ISO timestamp — request becomes executable once this has passed (30-day grace period in the source). */
  scheduled_delete_at: string;
}

export interface DeletionLogEntry {
  table: string;
  column: string;
  value: string;
  status: "deleted" | "skipped" | "error";
  detail: string;
  timestamp: string;
}

export interface SelectRowsOptions {
  limit?: number;
  /**
   * Hint for implementations: the exporter expects newest-first
   * (source used `order=created_at.desc`).
   */
  orderByCreatedAtDesc?: boolean;
}

export interface GdprStore {
  /** DELETE FROM table WHERE column = value. Must not throw for table-missing; use the outcome instead. */
  deleteRows(table: string, column: string, value: string): Promise<DeleteRowsOutcome>;
  /** SELECT * FROM table WHERE column = value. Missing table → []. */
  selectRows(
    table: string,
    column: string,
    value: string,
    options?: SelectRowsOptions,
  ): Promise<Record<string, unknown>[]>;
  /**
   * Pending deletion requests whose scheduled_delete_at <= nowIso
   * (source: status=eq.pending&scheduled_delete_at=lte.now).
   * Return null when the requests table itself does not exist.
   */
  listPendingDeletionRequests(nowIso: string): Promise<DeletionRequest[] | null>;
  /** Mark a request completed and attach the per-table deletion log. */
  markDeletionCompleted(
    requestId: string,
    deletedAtIso: string,
    log: DeletionLogEntry[],
  ): Promise<GdprStoreResult>;
}

/** In-memory reference implementation (tests / local dev). */
export class InMemoryGdprStore implements GdprStore {
  readonly tables = new Map<string, Record<string, unknown>[]>();
  /** Tables that behave as if they do not exist (404). */
  readonly missingTables = new Set<string>();
  /** table → error detail; deleteRows returns kind:"error" for these. */
  readonly failingTables = new Map<string, string>();
  readonly deletionRequests: Array<
    DeletionRequest & { deleted_at?: string; deletion_log?: DeletionLogEntry[] }
  > = [];
  /** Simulate the requests table not existing yet. */
  requestsTableMissing = false;

  seed(table: string, rows: Record<string, unknown>[]): void {
    this.tables.set(table, [...rows]);
  }

  async deleteRows(table: string, column: string, value: string): Promise<DeleteRowsOutcome> {
    if (this.missingTables.has(table)) {
      return { kind: "table-missing", detail: "table not found (404)" };
    }
    const failure = this.failingTables.get(table);
    if (failure !== undefined) {
      return { kind: "error", detail: failure };
    }
    const rows = this.tables.get(table) ?? [];
    const remaining = rows.filter((r) => String(r[column]) !== value);
    this.tables.set(table, remaining);
    return { kind: "deleted", count: rows.length - remaining.length };
  }

  async selectRows(
    table: string,
    column: string,
    value: string,
    options?: SelectRowsOptions,
  ): Promise<Record<string, unknown>[]> {
    if (this.missingTables.has(table)) return [];
    const rows = (this.tables.get(table) ?? []).filter((r) => String(r[column]) === value);
    return options?.limit != null ? rows.slice(0, options.limit) : rows;
  }

  async listPendingDeletionRequests(nowIso: string): Promise<DeletionRequest[] | null> {
    if (this.requestsTableMissing) return null;
    return this.deletionRequests.filter(
      (r) => r.status === "pending" && r.scheduled_delete_at <= nowIso,
    );
  }

  async markDeletionCompleted(
    requestId: string,
    deletedAtIso: string,
    log: DeletionLogEntry[],
  ): Promise<GdprStoreResult> {
    const req = this.deletionRequests.find((r) => r.id === requestId);
    if (!req) return { ok: false, error: "request not found" };
    req.status = "completed";
    req.deleted_at = deletedAtIso;
    req.deletion_log = log;
    return { ok: true };
  }
}
