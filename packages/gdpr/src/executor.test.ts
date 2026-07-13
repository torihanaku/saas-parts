/**
 * Ported from 実運用SaaS `tests/gdpr-executor.test.ts` and
 * `tests/gdpr-executor-cascade.test.ts`, adapted to the injected
 * GdprStore + caller-supplied cascade targets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createGdprExecutor,
  InMemoryGdprStore,
  silentGdprLogger,
  type CascadeTarget,
  type DeletionRequest,
} from "./index";

const TARGETS: CascadeTarget[] = [
  { table: "app_analytics", column: "user_id" },
  { table: "app_content_drafts", column: "author" },
  { table: "app_team_members", column: "email" },
  { table: "character_embeddings", column: "user_id" },
  { table: "nav_signals", column: "user_id" },
  { table: "nav_cards", column: "user_id" },
];

function makeRequest(overrides: Partial<DeletionRequest> = {}): DeletionRequest {
  return {
    id: "req-1",
    user_id: "user-123",
    email: "user@example.com",
    status: "pending",
    scheduled_delete_at: new Date().toISOString(),
    ...overrides,
  };
}

let store: InMemoryGdprStore;

beforeEach(() => {
  store = new InMemoryGdprStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeExecutor(extra: Partial<Parameters<typeof createGdprExecutor>[0]> = {}) {
  return createGdprExecutor({
    store,
    cascadeTargets: TARGETS,
    logger: silentGdprLogger,
    ...extra,
  });
}

describe("executeDeletion", () => {
  it("deletes from all cascade targets and returns log entries", async () => {
    for (const t of TARGETS) {
      store.seed(t.table, [{ [t.column]: t.column === "email" ? "user@example.com" : "user-123" }]);
    }
    store.deletionRequests.push(makeRequest());

    const executor = makeExecutor();
    const log = await executor.executeDeletion(makeRequest());

    expect(Array.isArray(log)).toBe(true);
    expect(log.length).toBe(TARGETS.length);
    expect(log.every((e) => e.status === "deleted" || e.status === "skipped" || e.status === "error")).toBe(true);
    expect(log.every((e) => e.status === "deleted")).toBe(true);
    // Should have marked request as completed
    const req = store.deletionRequests[0]!;
    expect(req.status).toBe("completed");
    expect(req.deletion_log).toEqual(log);
    expect(req.deleted_at).toBeDefined();
  });

  it('uses email identifier for "email" columns', async () => {
    const deleteSpy = vi.spyOn(store, "deleteRows");
    const executor = makeExecutor();
    await executor.executeDeletion(makeRequest({ id: "req-2", user_id: "uid-456", email: "target@example.com" }));

    const emailCall = deleteSpy.mock.calls.find(([table]) => table === "app_team_members");
    expect(emailCall).toBeTruthy();
    expect(emailCall![1]).toBe("email");
    expect(emailCall![2]).toBe("target@example.com");
    // Non-email columns use the user_id
    const idCall = deleteSpy.mock.calls.find(([table]) => table === "app_analytics");
    expect(idCall![2]).toBe("uid-456");
  });

  it('handles table not found gracefully with "skipped" status', async () => {
    for (const t of TARGETS) store.missingTables.add(t.table);
    const executor = makeExecutor();
    const log = await executor.executeDeletion(makeRequest({ id: "req-3", user_id: "uid-789" }));
    expect(log.some((e) => e.status === "skipped")).toBe(true);
    expect(log.every((e) => e.status === "skipped")).toBe(true);
  });

  it('handles store failure with "error" status in log entries', async () => {
    vi.spyOn(store, "deleteRows").mockRejectedValue(new Error("network error"));
    const executor = makeExecutor();
    const log = await executor.executeDeletion(makeRequest({ id: "req-4", user_id: "uid-net" }));
    expect(log.some((e) => e.status === "error")).toBe(true);
    expect(log.some((e) => e.detail.includes("network error"))).toBe(true);
  });

  it("does NOT mark the request completed when a table delete errors (residue guard)", async () => {
    // One table deletes fine, another fails (permission denied) leaving PII residue.
    store.seed("app_analytics", [{ user_id: "u1" }]);
    store.seed("app_team_members", [{ email: "u1@example.com" }]);
    store.failingTables.set("app_content_drafts", "permission denied");
    const req = makeRequest({ id: "req-residue", user_id: "u1", email: "u1@example.com" });
    store.deletionRequests.push(req);
    const markSpy = vi.spyOn(store, "markDeletionCompleted");

    const executor = createGdprExecutor({
      store,
      cascadeTargets: [
        { table: "app_analytics", column: "user_id" },
        { table: "app_content_drafts", column: "author" },
        { table: "app_team_members", column: "email" },
      ],
      logger: silentGdprLogger,
    });
    const log = await executor.executeDeletion(req);

    // The failing table is reported as an error in the log...
    expect(log.some((e) => e.table === "app_content_drafts" && e.status === "error")).toBe(true);
    // ...and crucially the request must NOT be recorded as completed.
    expect(markSpy).not.toHaveBeenCalled();
    expect(store.deletionRequests[0]!.status).toBe("pending");
  });

  it("still marks completed when tables are only skipped (table-missing), not errored", async () => {
    for (const t of TARGETS) store.missingTables.add(t.table);
    const req = makeRequest({ id: "req-skip", user_id: "uid-skip" });
    store.deletionRequests.push(req);
    const executor = makeExecutor();
    await executor.executeDeletion(req);
    expect(store.deletionRequests[0]!.status).toBe("completed");
  });

  it("logs error but does not throw when markDeletionCompleted fails", async () => {
    vi.spyOn(store, "markDeletionCompleted").mockResolvedValue({ ok: false });
    const executor = makeExecutor();
    await expect(executor.executeDeletion(makeRequest())).resolves.toBeDefined();
    expect(store.markDeletionCompleted).toHaveBeenCalled();
  });
});

describe("checkAndExecuteDeletions", () => {
  it("does nothing when no pending requests exist", async () => {
    const markSpy = vi.spyOn(store, "markDeletionCompleted");
    const executor = makeExecutor();
    await expect(executor.checkAndExecuteDeletions()).resolves.toBeUndefined();
    expect(markSpy).not.toHaveBeenCalled();
  });

  it("skips when the requests table does not exist", async () => {
    store.requestsTableMissing = true;
    const executor = makeExecutor();
    await expect(executor.checkAndExecuteDeletions()).resolves.toBeUndefined();
  });

  it("executes deletions for pending requests past their grace period", async () => {
    store.deletionRequests.push(
      makeRequest({
        id: "req-gdpr-1",
        user_id: "uid-1",
        email: "user1@example.com",
        scheduled_delete_at: new Date(Date.now() - 1000).toISOString(),
      }),
    );

    const executor = makeExecutor();
    await executor.checkAndExecuteDeletions();

    expect(store.deletionRequests[0]!.status).toBe("completed");
  });

  it("does NOT execute requests still inside the grace period", async () => {
    store.deletionRequests.push(
      makeRequest({
        id: "req-future",
        scheduled_delete_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    const executor = makeExecutor();
    await executor.checkAndExecuteDeletions();
    expect(store.deletionRequests[0]!.status).toBe("pending");
  });

  it("does not throw when the store fails", async () => {
    vi.spyOn(store, "listPendingDeletionRequests").mockRejectedValue(new Error("network error"));
    const executor = makeExecutor();
    await expect(executor.checkAndExecuteDeletions()).resolves.toBeUndefined();
  });

  it("continues past a failing request in the execution loop", async () => {
    store.deletionRequests.push(
      makeRequest({ id: "req-err", scheduled_delete_at: new Date(Date.now() - 1000).toISOString() }),
    );
    vi.spyOn(store, "markDeletionCompleted").mockRejectedValue(new Error("forced error"));
    const executor = makeExecutor();
    await expect(executor.checkAndExecuteDeletions()).resolves.toBeUndefined();
  });
});

describe("startDeletionChecker", () => {
  it("can be called without throwing and is idempotent", () => {
    const executor = makeExecutor();
    expect(() => {
      executor.startDeletionChecker();
      executor.startDeletionChecker();
    }).not.toThrow();
    executor.stopDeletionChecker();
  });

  it("runs the startup check after the configured delay", async () => {
    vi.useFakeTimers();
    const listSpy = vi.spyOn(store, "listPendingDeletionRequests");
    const executor = makeExecutor({ startupDelayMs: 30_000, checkIntervalMs: 3_600_000 });
    executor.startDeletionChecker();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(listSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(listSpy).toHaveBeenCalledTimes(2);
    executor.stopDeletionChecker();
    vi.useRealTimers();
  });
});

describe("verifyNoVectorResidue", () => {
  it("derives residue targets from cascade targets by default (source heuristic)", async () => {
    const selectSpy = vi.spyOn(store, "selectRows");
    const executor = makeExecutor();
    await executor.verifyNoVectorResidue("user-123");

    const calledTables = selectSpy.mock.calls.map((call) => call[0]);
    expect(calledTables).toContain("character_embeddings");
    expect(calledTables).toContain("nav_signals");
    expect(calledTables).toContain("nav_cards");
    // Non-vector tables are not scanned
    expect(calledTables).not.toContain("app_analytics");
    expect(calledTables).not.toContain("app_team_members");
  });

  it("throws when residue is found", async () => {
    store.seed("nav_cards", [{ user_id: "user-123" }]);
    const executor = makeExecutor();
    await expect(executor.verifyNoVectorResidue("user-123")).rejects.toThrow(
      "Vector residue found in nav_cards for user user-123",
    );
  });

  it("passes when all residue tables are empty", async () => {
    const executor = makeExecutor();
    await expect(executor.verifyNoVectorResidue("user-123")).resolves.toBeUndefined();
  });

  it("uses an explicit residueTargets config when supplied", async () => {
    const selectSpy = vi.spyOn(store, "selectRows");
    const executor = makeExecutor({
      residueTargets: [{ table: "custom_vectors", column: "owner_id" }],
    });
    await executor.verifyNoVectorResidue("user-9");
    expect(selectSpy.mock.calls.map((c) => c[0])).toEqual(["custom_vectors"]);
    expect(selectSpy.mock.calls[0]![1]).toBe("owner_id");
  });
});
