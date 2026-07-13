/**
 * Tests for @torihanaku/job-scheduler.
 * Ported from 実運用SaaS/tests/job-scheduler.test.ts — core scheduler
 * behaviors only (product-specific built-in job tests dropped). Supabase
 * mocks are replaced by a mocked JobStateStore.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { createJobScheduler, JobScheduler, InMemoryJobStateStore } from "./index";
import type { JobCompletionEvent, JobDefinition, JobStateStore } from "./index";

function makeJob(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    name: `test-job-${Date.now()}`,
    description: "A test job",
    intervalMs: 60_000,
    handler: vi.fn().mockResolvedValue(undefined),
    enabled: true,
    ...overrides,
  };
}

interface MockStore extends JobStateStore {
  update: Mock<JobStateStore["update"]>;
  insert: Mock<JobStateStore["insert"]>;
  loadEnabled: Mock<JobStateStore["loadEnabled"]>;
}

function makeMockStore(): MockStore {
  return {
    update: vi.fn<JobStateStore["update"]>().mockResolvedValue(true),
    insert: vi.fn<JobStateStore["insert"]>().mockResolvedValue(undefined),
    loadEnabled: vi.fn<JobStateStore["loadEnabled"]>().mockResolvedValue(null),
  };
}

describe("registerJob", () => {
  it("registers a job and it appears in getJobStates", () => {
    const scheduler = createJobScheduler();
    scheduler.registerJob(makeJob({ name: "register-test" }));
    const states = scheduler.getJobStates();
    const found = states.find((s) => s.name === "register-test");
    expect(found).toBeDefined();
    expect(found!.lastStatus).toBe("idle");
    expect(found!.runCount).toBe(0);
    expect(found!.enabled).toBe(true);
  });
});

describe("getJobStates", () => {
  it("returns info for all registered jobs", () => {
    const scheduler = createJobScheduler();
    scheduler.registerJob(makeJob({ name: "states-test" }));
    const states = scheduler.getJobStates();
    const found = states.find((s) => s.name === "states-test");
    expect(found).toMatchObject({
      name: "states-test",
      description: "A test job",
      intervalMs: 60_000,
      enabled: true,
      lastRunAt: null,
      lastStatus: "idle",
      lastError: null,
      runCount: 0,
      errorCount: 0,
    });
    expect(found!.nextRunAt).toBeDefined();
  });
});

describe("triggerJob", () => {
  it("triggers a registered job", async () => {
    const scheduler = createJobScheduler();
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerJob(makeJob({ name: "trigger-test", handler }));
    const result = await scheduler.triggerJob("trigger-test");
    expect(result.ok).toBe(true);
  });

  it("returns error for unknown job", async () => {
    const scheduler = createJobScheduler();
    const result = await scheduler.triggerJob("nonexistent-job");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("setJobEnabled", () => {
  it("disables a registered job", () => {
    const scheduler = createJobScheduler();
    scheduler.registerJob(makeJob({ name: "enable-test", enabled: true }));
    const result = scheduler.setJobEnabled("enable-test", false);
    expect(result.ok).toBe(true);
    const found = scheduler.getJobStates().find((s) => s.name === "enable-test");
    expect(found!.enabled).toBe(false);
  });

  it("returns error for unknown job", () => {
    const scheduler = createJobScheduler();
    const result = scheduler.setJobEnabled("nonexistent", true);
    expect(result.ok).toBe(false);
  });
});

describe("start / stop", () => {
  let scheduler: JobScheduler;

  beforeEach(() => {
    scheduler = createJobScheduler();
  });

  afterEach(() => {
    scheduler.stop();
  });

  it("starts and stops without error", () => {
    expect(() => scheduler.start()).not.toThrow();
    expect(() => scheduler.stop()).not.toThrow();
  });

  it("calling start twice is idempotent", () => {
    scheduler.start();
    expect(() => scheduler.start()).not.toThrow();
  });

  it("calling stop when not started is safe", () => {
    expect(() => scheduler.stop()).not.toThrow();
  });
});

// =========================================================================
// Execution behavior
// =========================================================================

describe("triggerJob — execution behavior", () => {
  it("increments runCount after successful execution", async () => {
    const scheduler = createJobScheduler();
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerJob(makeJob({ name: "run-count-test", handler }));

    await scheduler.triggerJob("run-count-test");
    // Allow the fire-and-forget executeJob to complete
    await vi.waitFor(() => {
      const found = scheduler.getJobStates().find((s) => s.name === "run-count-test");
      expect(found!.runCount).toBeGreaterThanOrEqual(1);
    });
  });

  it("sets lastStatus to success after successful handler", async () => {
    const scheduler = createJobScheduler();
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerJob(makeJob({ name: "success-status-test", handler }));
    await scheduler.triggerJob("success-status-test");

    await vi.waitFor(() => {
      const found = scheduler.getJobStates().find((s) => s.name === "success-status-test");
      expect(found!.lastStatus).toBe("success");
    });
  });

  it("updates lastRunAt after execution", async () => {
    const scheduler = createJobScheduler();
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerJob(makeJob({ name: "lastrun-test", handler }));

    const before = scheduler.getJobStates().find((s) => s.name === "lastrun-test");
    expect(before!.lastRunAt).toBeNull();

    await scheduler.triggerJob("lastrun-test");

    await vi.waitFor(() => {
      const after = scheduler.getJobStates().find((s) => s.name === "lastrun-test");
      expect(after!.lastRunAt).not.toBeNull();
    });
  });

  it("sets error status and increments errorCount when handler throws", async () => {
    const scheduler = createJobScheduler();
    const handler = vi.fn().mockRejectedValue(new Error("test failure"));
    scheduler.registerJob(makeJob({ name: "error-test", handler }));
    await scheduler.triggerJob("error-test");

    await vi.waitFor(() => {
      const found = scheduler.getJobStates().find((s) => s.name === "error-test");
      expect(found!.lastStatus).toBe("error");
      expect(found!.errorCount).toBe(1);
      expect(found!.lastError).toBe("test failure");
    });
  });

  it("sets lastError from non-Error thrown values", async () => {
    const scheduler = createJobScheduler();
    const handler = vi.fn().mockRejectedValue("string error");
    scheduler.registerJob(makeJob({ name: "string-error-test", handler }));
    await scheduler.triggerJob("string-error-test");

    await vi.waitFor(() => {
      const found = scheduler.getJobStates().find((s) => s.name === "string-error-test");
      expect(found!.lastStatus).toBe("error");
      expect(found!.lastError).toBe("string error");
    });
  });

  it("prevents concurrent execution of the same job", async () => {
    const scheduler = createJobScheduler();
    let resolveHandler: () => void = () => {};
    const handler = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveHandler = resolve; })
    );
    scheduler.registerJob(makeJob({ name: "concurrent-test", handler }));

    // Start first execution (will hang until resolveHandler is called)
    await scheduler.triggerJob("concurrent-test");
    // Wait for the handler to start
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    // Try triggering again while still running
    const result = await scheduler.triggerJob("concurrent-test");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already running");

    // Clean up: resolve the hanging handler
    resolveHandler();
  });

  it("calls store.update (upsertJobRow) after execution", async () => {
    const store = makeMockStore();
    const scheduler = createJobScheduler({ store });
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerJob(makeJob({ name: "persist-test", handler }));

    await scheduler.triggerJob("persist-test");

    await vi.waitFor(() => {
      expect(store.update).toHaveBeenCalledWith(
        "persist-test",
        expect.objectContaining({
          name: "persist-test",
          last_status: "success",
          run_count: 1,
        })
      );
    });
  });

  it("falls back to store.insert when store.update returns falsy", async () => {
    const store = makeMockStore();
    store.update.mockResolvedValue(false);

    const scheduler = createJobScheduler({ store });
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerJob(makeJob({ name: "insert-fallback-test", handler }));

    await scheduler.triggerJob("insert-fallback-test");

    await vi.waitFor(() => {
      expect(store.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "insert-fallback-test",
          created_at: expect.any(String),
        })
      );
    });
  });
});

describe("setJobEnabled — extended", () => {
  it("enables a previously disabled job", () => {
    const scheduler = createJobScheduler();
    scheduler.registerJob(makeJob({ name: "reenable-test", enabled: false }));
    expect(scheduler.getJobStates().find((s) => s.name === "reenable-test")!.enabled).toBe(false);

    scheduler.setJobEnabled("reenable-test", true);
    expect(scheduler.getJobStates().find((s) => s.name === "reenable-test")!.enabled).toBe(true);
  });

  it("persists the enabled change via store.update", () => {
    const store = makeMockStore();
    const scheduler = createJobScheduler({ store });

    scheduler.registerJob(makeJob({ name: "persist-enable-test", enabled: true }));
    scheduler.setJobEnabled("persist-enable-test", false);

    // fire-and-forget, but it should have been called
    expect(store.update).toHaveBeenCalledWith(
      "persist-enable-test",
      expect.objectContaining({ enabled: false })
    );
  });
});

// =========================================================================
// Tick behavior
// =========================================================================

describe("tick behavior (via start)", () => {
  let scheduler: JobScheduler | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = null;
    vi.useRealTimers();
  });

  it("executes a job that is past its nextRunAt", async () => {
    const store = makeMockStore();
    store.loadEnabled.mockResolvedValue(true);
    scheduler = createJobScheduler({ store });

    const handler = vi.fn().mockResolvedValue(undefined);
    // Register with a very short interval so it is immediately due
    scheduler.registerJob(makeJob({ name: "tick-due-test", handler, intervalMs: 1 }));

    scheduler.start();

    // Advance past the initial 5s delay for the first tick
    await vi.advanceTimersByTimeAsync(6_000);

    expect(handler).toHaveBeenCalled();
  });

  it("skips disabled jobs during tick", async () => {
    scheduler = createJobScheduler({ store: makeMockStore() });
    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerJob(makeJob({ name: "tick-disabled-test", handler, enabled: false, intervalMs: 1 }));

    scheduler.start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(handler).not.toHaveBeenCalled();
  });

  it("disables a job when the store returns enabled=false", async () => {
    const store = makeMockStore();
    // loadJobRowEnabled will return enabled: false
    store.loadEnabled.mockResolvedValue(false);
    scheduler = createJobScheduler({ store });

    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerJob(makeJob({ name: "db-disable-test", handler, intervalMs: 1 }));

    scheduler.start();
    await vi.advanceTimersByTimeAsync(6_000);

    // The handler should NOT be called because the store says disabled
    expect(handler).not.toHaveBeenCalled();
    // And the local state should be updated
    const found = scheduler.getJobStates().find((s) => s.name === "db-disable-test");
    expect(found!.enabled).toBe(false);
  });

  it("skips jobs that are not yet due", async () => {
    const store = makeMockStore();
    store.loadEnabled.mockResolvedValue(true);
    scheduler = createJobScheduler({ store });

    const handler = vi.fn().mockResolvedValue(undefined);
    // Very long interval - won't be due for a long time
    scheduler.registerJob(makeJob({ name: "tick-not-due-test", handler, intervalMs: 999_999_999 }));

    scheduler.start();
    await vi.advanceTimersByTimeAsync(6_000);

    // Handler should not be called — nextRunAt is far in the future
    expect(handler).not.toHaveBeenCalled();
  });

  it("persists initial state on scheduler start after delay", async () => {
    const store = makeMockStore();
    scheduler = createJobScheduler({ store });

    scheduler.registerJob(makeJob({ name: "initial-persist-test", intervalMs: 999_999_999 }));
    scheduler.start();

    // Advance past the 5s initial delay
    await vi.advanceTimersByTimeAsync(5_500);

    // upsertJobRow should have been called for initial state persistence
    expect(store.update).toHaveBeenCalledWith(
      "initial-persist-test",
      expect.objectContaining({ name: "initial-persist-test" })
    );
  });
});

describe("tick — loadEnabled returns null (no store row)", () => {
  let scheduler: JobScheduler | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    scheduler?.stop();
    scheduler = null;
    vi.useRealTimers();
  });

  it("proceeds to run job when loadEnabled returns null", async () => {
    const store = makeMockStore();
    // No row found → returns null
    store.loadEnabled.mockResolvedValue(null);
    scheduler = createJobScheduler({ store });

    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerJob(makeJob({ name: "null-enabled-test", handler, intervalMs: 1 }));

    scheduler.start();
    await vi.advanceTimersByTimeAsync(6_000);

    // When loadEnabled returns null (not false), the job should run
    expect(handler).toHaveBeenCalled();
  });

  it("runs jobs on tick when no store is configured at all", async () => {
    scheduler = createJobScheduler(); // no store

    const handler = vi.fn().mockResolvedValue(undefined);
    scheduler.registerJob(makeJob({ name: "no-store-tick-test", handler, intervalMs: 1 }));

    scheduler.start();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(handler).toHaveBeenCalled();
  });
});

// =========================================================================
// Regression: overlapping ticks / trigger-vs-tick must not double-run a job
// (the "running" lock is claimed synchronously, before the loadEnabled await)
// =========================================================================

describe("no double-run under overlapping ticks", () => {
  let scheduler: JobScheduler | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    scheduler?.stop();
    scheduler = null;
    vi.useRealTimers();
  });

  it("a slow loadEnabled does not let two ticks run the SAME job concurrently", async () => {
    const store = makeMockStore();
    // loadEnabled is slow: the tick that started it holds the async gap open
    // long enough for the next tick interval to fire. Before the fix, both
    // ticks passed the running-guard (still "idle") and each launched the
    // handler for the same due window → concurrent execution.
    store.loadEnabled.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(true), 200))
    );

    let inFlight = 0;
    let maxConcurrent = 0;
    const handler = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 500));
      inFlight--;
    });

    // Short check interval so a 2nd tick fires during the loadEnabled delay.
    scheduler = createJobScheduler({ store, checkIntervalMs: 50 });
    scheduler.registerJob(makeJob({ name: "overlap-test", handler, intervalMs: 1 }));

    scheduler.start();
    await vi.advanceTimersByTimeAsync(6_000);

    // The job may run many times over 6s (interval 1ms), but never twice at once.
    expect(maxConcurrent).toBe(1);
  });

  it("triggerJob racing an in-flight tick is rejected as already running", async () => {
    const store = makeMockStore();
    store.loadEnabled.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(true), 200))
    );

    let inFlight = 0;
    let maxConcurrent = 0;
    const handler = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 500));
      inFlight--;
    });

    // Job is due (short interval) so ticks are firing and holding the slow
    // loadEnabled gap open; a manual trigger during that gap must still not
    // start a second concurrent execution.
    scheduler = createJobScheduler({ store, checkIntervalMs: 50 });
    scheduler.registerJob(makeJob({ name: "trigger-race-test", handler, intervalMs: 1 }));

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5_100);
    // Fire many manual triggers across the window, racing in-flight ticks.
    for (let i = 0; i < 10; i++) {
      void scheduler.triggerJob("trigger-race-test");
      await vi.advanceTimersByTimeAsync(30);
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(maxConcurrent).toBe(1);
  });
});

// =========================================================================
// on-complete hook (replaces the project webhook/notification coupling)
// =========================================================================

describe("onComplete hook", () => {
  it("is invoked with a success event after a successful run", async () => {
    const onComplete = vi.fn();
    const scheduler = createJobScheduler({ onComplete });
    scheduler.registerJob(makeJob({ name: "hook-success-test" }));

    await scheduler.triggerJob("hook-success-test");

    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "hook-success-test",
          status: "success",
          error: null,
          runCount: 1,
          errorCount: 0,
          durationMs: expect.any(Number),
          lastRunAt: expect.any(String),
          nextRunAt: expect.any(String),
        })
      );
    });
  });

  it("is invoked with an error event when the handler throws", async () => {
    const events: JobCompletionEvent[] = [];
    const scheduler = createJobScheduler({ onComplete: (e) => { events.push(e); } });
    const handler = vi.fn().mockRejectedValue(new Error("hook failure"));
    scheduler.registerJob(makeJob({ name: "hook-error-test", handler }));

    await scheduler.triggerJob("hook-error-test");

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: "hook-error-test",
        status: "error",
        error: "hook failure",
        errorCount: 1,
      });
    });
  });

  it("a throwing onComplete hook does not break job state", async () => {
    const onComplete = vi.fn().mockRejectedValue(new Error("hook exploded"));
    const scheduler = createJobScheduler({ onComplete });
    scheduler.registerJob(makeJob({ name: "hook-throw-test" }));

    await scheduler.triggerJob("hook-throw-test");

    await vi.waitFor(() => {
      const found = scheduler.getJobStates().find((s) => s.name === "hook-throw-test");
      expect(found!.lastStatus).toBe("success");
      expect(onComplete).toHaveBeenCalled();
    });
  });
});

// =========================================================================
// InMemoryJobStateStore
// =========================================================================

describe("InMemoryJobStateStore", () => {
  it("update returns false when no row exists (insert fallback path)", async () => {
    const store = new InMemoryJobStateStore();
    const scheduler = createJobScheduler({ store });
    scheduler.registerJob(makeJob({ name: "mem-store-test" }));

    await scheduler.triggerJob("mem-store-test");

    await vi.waitFor(() => {
      const row = store.getRow("mem-store-test");
      expect(row).toBeDefined();
      expect(row!.created_at).toEqual(expect.any(String));
      expect(row!.last_status).toBe("success");
      expect(row!.run_count).toBe(1);
    });
  });

  it("update merges into an existing row on subsequent runs", async () => {
    const store = new InMemoryJobStateStore();
    const scheduler = createJobScheduler({ store });
    scheduler.registerJob(makeJob({ name: "mem-store-twice-test" }));

    await scheduler.triggerJob("mem-store-twice-test");
    await vi.waitFor(() => {
      expect(store.getRow("mem-store-twice-test")?.run_count).toBe(1);
    });

    await scheduler.triggerJob("mem-store-twice-test");
    await vi.waitFor(() => {
      expect(store.getRow("mem-store-twice-test")?.run_count).toBe(2);
    });
    // created_at from the first insert is preserved by the merge
    expect(store.getRow("mem-store-twice-test")?.created_at).toEqual(expect.any(String));
  });

  it("loadEnabled reflects setJobEnabled persistence", async () => {
    const store = new InMemoryJobStateStore();
    expect(await store.loadEnabled("unknown")).toBeNull();

    const scheduler = createJobScheduler({ store });
    scheduler.registerJob(makeJob({ name: "mem-store-enabled-test" }));
    await scheduler.triggerJob("mem-store-enabled-test");
    await vi.waitFor(() => {
      expect(store.getRow("mem-store-enabled-test")).toBeDefined();
    });

    scheduler.setJobEnabled("mem-store-enabled-test", false);
    await vi.waitFor(async () => {
      expect(await store.loadEnabled("mem-store-enabled-test")).toBe(false);
    });
  });
});
