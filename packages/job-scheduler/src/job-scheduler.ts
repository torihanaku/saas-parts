/**
 * General-purpose background job/cron scheduler.
 * Registers named jobs with intervals, tracks execution status, optionally
 * persists state via an injected JobStateStore, and provides an API for
 * monitoring and manual triggering.
 *
 * Ported from dev-dashboard-v2/server/lib/job-scheduler.ts (core only —
 * product job registrations and Supabase coupling removed).
 */
import type {
  JobCompletionEvent,
  JobDefinition,
  JobSchedulerOptions,
  JobStateInfo,
  JobStateStore,
  PersistedJobRow,
} from "./types";

const DEFAULT_CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds
const DEFAULT_INITIAL_DELAY_MS = 5_000;

interface JobState {
  definition: JobDefinition;
  lastRunAt: Date | null;
  nextRunAt: Date;
  lastStatus: "idle" | "running" | "success" | "error";
  lastError: string | null;
  runCount: number;
  errorCount: number;
}

function logInfo(detail: string): void {
  console.warn(JSON.stringify({ severity: "INFO", message: "job_scheduler", detail }));
}

export class JobScheduler {
  private readonly jobs: Map<string, JobState> = new Map();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private initialTimeout: ReturnType<typeof setTimeout> | null = null;

  private readonly store: JobStateStore | undefined;
  private readonly onComplete: JobSchedulerOptions["onComplete"];
  private readonly checkIntervalMs: number;
  private readonly initialDelayMs: number;

  constructor(options: JobSchedulerOptions = {}) {
    this.store = options.store;
    this.onComplete = options.onComplete;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  }

  // -------------------------------------------------------------------------
  // Persistence (mirrors upsertJobRow / loadJobRowEnabled from the source)
  // -------------------------------------------------------------------------

  private buildRow(state: JobState): PersistedJobRow {
    return {
      name: state.definition.name,
      description: state.definition.description,
      interval_ms: state.definition.intervalMs,
      enabled: state.definition.enabled,
      last_run_at: state.lastRunAt?.toISOString() ?? null,
      next_run_at: state.nextRunAt.toISOString(),
      last_status: state.lastStatus,
      last_error: state.lastError,
      run_count: state.runCount,
      error_count: state.errorCount,
      updated_at: new Date().toISOString(),
    };
  }

  private async upsertJobRow(state: JobState): Promise<void> {
    if (!this.store) return;
    const row = this.buildRow(state);

    // Try UPDATE first (existing row), fall back to INSERT
    const updated = await this.store.update(state.definition.name, row);
    if (!updated) {
      await this.store.insert({ ...row, created_at: new Date().toISOString() });
    }
  }

  private async loadJobRowEnabled(name: string): Promise<boolean | null> {
    if (!this.store) return null;
    return this.store.loadEnabled(name);
  }

  // -------------------------------------------------------------------------
  // Core scheduler
  // -------------------------------------------------------------------------

  registerJob(def: JobDefinition): void {
    const now = new Date();
    const state: JobState = {
      definition: { ...def },
      lastRunAt: null,
      nextRunAt: new Date(now.getTime() + def.intervalMs),
      lastStatus: "idle",
      lastError: null,
      runCount: 0,
      errorCount: 0,
    };
    this.jobs.set(def.name, state);
    logInfo(`Registered job: ${def.name} (interval: ${def.intervalMs}ms, enabled: ${def.enabled})`);
  }

  private async executeJob(state: JobState): Promise<void> {
    const { definition } = state;
    logInfo(`Starting job: ${definition.name}`);
    state.lastStatus = "running";
    const startTime = Date.now();

    try {
      await definition.handler();
      state.lastStatus = "success";
      state.lastError = null;
      logInfo(`Completed job: ${definition.name} (${Date.now() - startTime}ms)`);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      state.lastStatus = "error";
      state.lastError = error.message;
      state.errorCount++;
      console.error(`[JobScheduler] Job failed: ${definition.name} — ${state.lastError}`);
    }

    const durationMs = Date.now() - startTime;
    state.runCount++;
    state.lastRunAt = new Date();
    state.nextRunAt = new Date(Date.now() + definition.intervalMs);

    // Persist to store (fire-and-forget)
    this.upsertJobRow(state).catch((err: unknown) => {
      console.error(JSON.stringify({ severity: "ERROR", message: "job_persist_failed", job: definition.name, error: String(err) }));
    });

    // Notify optional on-complete hook (fire-and-forget)
    if (this.onComplete) {
      const event: JobCompletionEvent = {
        name: definition.name,
        status: state.lastStatus === "error" ? "error" : "success",
        error: state.lastError,
        durationMs,
        runCount: state.runCount,
        errorCount: state.errorCount,
        lastRunAt: state.lastRunAt.toISOString(),
        nextRunAt: state.nextRunAt.toISOString(),
      };
      Promise.resolve()
        .then(() => this.onComplete?.(event))
        .catch((err: unknown) => {
          console.error(JSON.stringify({ severity: "ERROR", message: "job_on_complete_failed", job: definition.name, error: String(err) }));
        });
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    for (const [, state] of this.jobs) {
      if (!state.definition.enabled) continue;
      if (state.lastStatus === "running") continue; // already running
      if (now < state.nextRunAt) continue;

      // Sync enabled flag from store (non-blocking for other jobs)
      const storedEnabled = await this.loadJobRowEnabled(state.definition.name);
      if (storedEnabled === false) {
        state.definition.enabled = false;
        continue;
      }

      this.executeJob(state).catch((err: unknown) => {
        console.error(`[JobScheduler] Uncaught error in job ${state.definition.name}:`, err instanceof Error ? err.message : err);
      }); // don't await — run concurrently
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => {
      this.tick().catch((err: unknown) => {
        console.error("[JobScheduler] Tick failed:", err instanceof Error ? err.message : err);
      });
    }, this.checkIntervalMs);
    logInfo(`Scheduler started (tick every ${this.checkIntervalMs / 1000}s)`);

    // Persist initial state for all jobs after a short delay
    this.initialTimeout = setTimeout(async () => {
      for (const [, state] of this.jobs) {
        await this.upsertJobRow(state).catch((err: unknown) => {
          console.error(JSON.stringify({ severity: "ERROR", message: "job_initial_persist_failed", job: state.definition.name, error: String(err) }));
        });
      }
      // Run first tick
      this.tick().catch((err: unknown) => {
        console.error("[JobScheduler] First tick failed:", err instanceof Error ? err.message : err);
      });
    }, this.initialDelayMs);
  }

  stop(): void {
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      console.warn(JSON.stringify({ severity: "INFO", message: "job_scheduler_stopped" }));
    }
  }

  getJobStates(): JobStateInfo[] {
    return Array.from(this.jobs.values()).map((s) => ({
      name: s.definition.name,
      description: s.definition.description,
      intervalMs: s.definition.intervalMs,
      enabled: s.definition.enabled,
      lastRunAt: s.lastRunAt?.toISOString() ?? null,
      nextRunAt: s.nextRunAt.toISOString(),
      lastStatus: s.lastStatus,
      lastError: s.lastError,
      runCount: s.runCount,
      errorCount: s.errorCount,
    }));
  }

  async triggerJob(name: string): Promise<{ ok: boolean; error?: string }> {
    const state = this.jobs.get(name);
    if (!state) return { ok: false, error: `Job not found: ${name}` };
    if (state.lastStatus === "running") return { ok: false, error: `Job already running: ${name}` };
    this.executeJob(state).catch((err: unknown) => {
      console.error(JSON.stringify({ severity: "ERROR", message: "job_trigger_failed", job: name, error: String(err) }));
    });
    return { ok: true };
  }

  setJobEnabled(name: string, enabled: boolean): { ok: boolean; error?: string } {
    const state = this.jobs.get(name);
    if (!state) return { ok: false, error: `Job not found: ${name}` };
    state.definition.enabled = enabled;
    this.upsertJobRow(state).catch((err: unknown) => {
      console.error(JSON.stringify({ severity: "ERROR", message: "job_enable_persist_failed", job: name, error: String(err) }));
    });
    return { ok: true };
  }
}

export function createJobScheduler(options: JobSchedulerOptions = {}): JobScheduler {
  return new JobScheduler(options);
}
