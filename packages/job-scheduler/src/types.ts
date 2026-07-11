/**
 * Types for @torihanaku/job-scheduler.
 * Ported from dev-dashboard-v2/server/lib/job-scheduler.ts (core only).
 */

/** A named background job with a fixed execution interval. */
export interface JobDefinition {
  name: string;
  description: string;
  intervalMs: number;
  handler: () => Promise<void>;
  enabled: boolean;
}

export type JobRunStatus = "idle" | "running" | "success" | "error";

/** Snapshot of a job's runtime state (JSON-safe, for monitoring APIs). */
export interface JobStateInfo {
  name: string;
  description: string;
  intervalMs: number;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  lastStatus: JobRunStatus;
  lastError: string | null;
  runCount: number;
  errorCount: number;
}

/**
 * Row shape persisted to the state store.
 * Mirrors the columns the source wrote to the `dd_scheduled_jobs` Supabase
 * table (snake_case preserved so existing tables keep working).
 */
export interface PersistedJobRow {
  name: string;
  description: string;
  interval_ms: number;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string;
  last_status: JobRunStatus;
  last_error: string | null;
  run_count: number;
  error_count: number;
  updated_at: string;
}

/**
 * Pluggable persistence for job state.
 * Mirrors the exact operations the source performed against Supabase:
 * - `update`  … PATCH `dd_scheduled_jobs?name=eq.{name}` (returns whether a
 *               row was updated; falsy triggers the insert fallback)
 * - `insert`  … INSERT `{ ...row, created_at }` when no row existed yet
 * - `loadEnabled` … SELECT `enabled` by name before each due run
 *                   (`null` = row/store unavailable → run proceeds)
 */
export interface JobStateStore {
  update(name: string, row: PersistedJobRow): Promise<boolean>;
  insert(row: PersistedJobRow & { created_at: string }): Promise<void>;
  loadEnabled(name: string): Promise<boolean | null>;
}

/** Event passed to the optional on-complete hook after every execution. */
export interface JobCompletionEvent {
  name: string;
  status: "success" | "error";
  error: string | null;
  durationMs: number;
  runCount: number;
  errorCount: number;
  lastRunAt: string;
  nextRunAt: string;
}

export type JobCompleteHook = (event: JobCompletionEvent) => void | Promise<void>;

export interface JobSchedulerOptions {
  /**
   * State persistence. When omitted the scheduler is purely in-memory:
   * persistence calls are skipped and the pre-run enabled check behaves as
   * "no row found" (job runs) — same behavior as the source when the DB
   * returned nothing.
   */
  store?: JobStateStore;
  /** Optional hook invoked (fire-and-forget) after each job execution. */
  onComplete?: JobCompleteHook;
  /** Tick loop interval. Source default: 30_000 ms. */
  checkIntervalMs?: number;
  /**
   * Delay after start() before the initial state persist + first tick.
   * Source default: 5_000 ms.
   */
  initialDelayMs?: number;
}
