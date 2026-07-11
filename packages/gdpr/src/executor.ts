/**
 * GDPR Data Deletion Executor.
 * Periodically checks for pending deletion requests whose grace period has
 * expired, then cascade-deletes user data from all configured tables and
 * logs each step.
 *
 * Ported from dev-dashboard-v2 `server/lib/gdpr-executor.ts`.
 * The table manifest (CASCADE_TARGETS) is now caller-supplied config;
 * persistence is an injected `GdprStore`.
 */
import type { DeletionLogEntry, DeletionRequest, GdprStore } from "./store";
import { consoleGdprLogger, type GdprLogger } from "./logger";

/** One cascade-deletion target: the table and the column identifying the user. */
export interface CascadeTarget {
  table: string;
  column: string;
}

/**
 * Documented example manifest (renamed from the source's app-specific list).
 * Supply your own array to `createGdprExecutor`.
 * Columns named "email" are matched against the request's email;
 * every other column is matched against user_id (source behavior).
 */
export const EXAMPLE_CASCADE_TARGETS: CascadeTarget[] = [
  { table: "app_analytics", column: "user_id" },
  { table: "app_content_drafts", column: "author" },
  { table: "app_team_members", column: "email" },
];

export interface GdprExecutorOptions {
  store: GdprStore;
  /** Tables to cascade-delete from (source: CASCADE_TARGETS). */
  cascadeTargets: CascadeTarget[];
  /**
   * Tables to scan in `verifyNoVectorResidue`. If omitted, falls back to the
   * source heuristic: cascade targets whose table name contains
   * "embeddings" / "memory" / "dna" or starts with "nav_".
   */
  residueTargets?: CascadeTarget[];
  logger?: GdprLogger;
  /** Deletion checker interval. Source: 3,600,000ms (hourly). */
  checkIntervalMs?: number;
  /** Startup delay before the first check. Source: 30,000ms. */
  startupDelayMs?: number;
}

export interface GdprExecutor {
  /** Throws if any residue-target table still has rows for the user. */
  verifyNoVectorResidue(userId: string): Promise<void>;
  /** Cascade-delete a single request across all targets, then mark it completed. */
  executeDeletion(request: DeletionRequest): Promise<DeletionLogEntry[]>;
  /** Find pending requests past their scheduled_delete_at and execute them. Never throws. */
  checkAndExecuteDeletions(): Promise<void>;
  /** Start the periodic checker (hourly, 30s startup delay by default). Idempotent. */
  startDeletionChecker(): void;
  /** Stop the periodic checker (added for testability; not in the source). */
  stopDeletionChecker(): void;
}

export function createGdprExecutor(options: GdprExecutorOptions): GdprExecutor {
  const { store, cascadeTargets } = options;
  const logger = options.logger ?? consoleGdprLogger;
  const checkIntervalMs = options.checkIntervalMs ?? 3_600_000;
  const startupDelayMs = options.startupDelayMs ?? 30_000;

  const residueTargets =
    options.residueTargets ??
    cascadeTargets.filter(
      (t) =>
        t.table.includes("embeddings") ||
        t.table.includes("memory") ||
        t.table.includes("dna") ||
        t.table.startsWith("nav_"),
    );

  async function verifyNoVectorResidue(userId: string): Promise<void> {
    for (const target of residueTargets) {
      const res = await store.selectRows(target.table, target.column, userId, { limit: 1 });
      if (res && res.length > 0) {
        throw new Error(`Vector residue found in ${target.table} for user ${userId}`);
      }
    }
  }

  /**
   * Delete rows from a single table for a given user identifier.
   * Returns a log entry. Handles missing tables gracefully.
   */
  async function deleteFromTable(
    table: string,
    column: string,
    value: string,
  ): Promise<DeletionLogEntry> {
    const ts = new Date().toISOString();
    try {
      const outcome = await store.deleteRows(table, column, value);

      if (outcome.kind === "deleted") {
        logger.info("gdpr", `Deleted ${outcome.count} rows from ${table} where ${column}=${value}`);
        return {
          table,
          column,
          value,
          status: "deleted",
          detail: `${outcome.count} rows deleted`,
          timestamp: ts,
        };
      }

      if (outcome.kind === "table-missing") {
        logger.info("gdpr", `Table ${table} not found, skipping`);
        return { table, column, value, status: "skipped", detail: outcome.detail, timestamp: ts };
      }

      logger.warn("gdpr", `Delete from ${table} failed: ${outcome.detail}`);
      return { table, column, value, status: "error", detail: outcome.detail.slice(0, 200), timestamp: ts };
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error("gdpr", error);
      return {
        table,
        column,
        value,
        status: "error",
        detail: error.message || "unknown error",
        timestamp: ts,
      };
    }
  }

  /**
   * Execute cascade deletion for a single deletion request.
   * Deletes from all target tables using both user_id and email as identifiers.
   */
  async function executeDeletion(request: DeletionRequest): Promise<DeletionLogEntry[]> {
    const log: DeletionLogEntry[] = [];

    logger.info("gdpr", `Executing deletion for request ${request.id}`);

    for (const target of cascadeTargets) {
      // Determine which value to use for this table's column
      const value = target.column === "email" ? request.email : request.user_id;
      const entry = await deleteFromTable(target.table, target.column, value);
      log.push(entry);
    }

    // Mark request as completed
    const now = new Date().toISOString();
    const result = await store.markDeletionCompleted(request.id, now, log);

    if (result.ok) {
      logger.info("gdpr", `Deletion request ${request.id} marked as completed`);
    } else {
      logger.error("gdpr", `Failed to update deletion request ${request.id} status`);
    }

    return log;
  }

  /**
   * Check for pending deletion requests whose scheduled_delete_at has passed,
   * and execute them.
   */
  async function checkAndExecuteDeletions(): Promise<void> {
    try {
      const now = new Date().toISOString();
      const requests = await store.listPendingDeletionRequests(now);

      if (requests === null) {
        // Table might not exist yet
        logger.info("gdpr", "deletion requests table not found, skipping check");
        return;
      }

      if (requests.length === 0) return;

      logger.info("gdpr", `Found ${requests.length} pending deletion request(s) ready for execution`);

      for (const request of requests) {
        try {
          await executeDeletion(request);
        } catch (e: unknown) {
          const error = e instanceof Error ? e : new Error(String(e));
          logger.error("gdpr", `Deletion execution failed for ${request.id}: ${error.message}`);
        }
      }
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error("gdpr", error);
    }
  }

  let gdprInterval: ReturnType<typeof setInterval> | null = null;
  let startupTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start the GDPR deletion checker.
   * Runs hourly with a 30-second startup delay (source defaults).
   */
  function startDeletionChecker(): void {
    if (gdprInterval) return;
    gdprInterval = setInterval(checkAndExecuteDeletions, checkIntervalMs);
    logger.info("gdpr", `Deletion checker started (checking every ${Math.round(checkIntervalMs / 60000)}min)`);
    // Run once at startup after a delay
    startupTimeout = setTimeout(checkAndExecuteDeletions, startupDelayMs);
  }

  function stopDeletionChecker(): void {
    if (gdprInterval) {
      clearInterval(gdprInterval);
      gdprInterval = null;
    }
    if (startupTimeout) {
      clearTimeout(startupTimeout);
      startupTimeout = null;
    }
  }

  return {
    verifyNoVectorResidue,
    executeDeletion,
    checkAndExecuteDeletions,
    startDeletionChecker,
    stopDeletionChecker,
  };
}
