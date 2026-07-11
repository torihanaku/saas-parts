import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  createDeploymentSnapshot,
  type RollbackDecisionEntry,
  type DeploymentSnapshot,
} from "./index";

describe("DeploymentSnapshot", () => {
  const stateRows = [{ tenant_id: "t1", dna: "current" }];
  let fetchState: Mock<(tenantId: string) => Promise<unknown[]>>;
  let put: Mock<(key: string, content: string) => Promise<void>>;
  let inserted: RollbackDecisionEntry[];
  let warnings: string[];
  let snapshot: DeploymentSnapshot;

  beforeEach(() => {
    fetchState = vi.fn().mockResolvedValue(stateRows);
    put = vi.fn().mockResolvedValue(undefined);
    inserted = [];
    warnings = [];
    snapshot = createDeploymentSnapshot({
      stateSource: { fetchState },
      snapshotStore: { put },
      decisionLog: {
        insert: async (e) => {
          inserted.push(e);
        },
      },
      warn: (m) => warnings.push(m),
      now: () => 1_700_000_000_000,
    });
  });

  it("should capture snapshot before deployment (key format + persisted JSON)", async () => {
    const key = await snapshot.capturePreDeploySnapshot("t1", "d1");
    expect(key).toBe("snapshots/t1/d1-1700000000000.json");
    expect(fetchState).toHaveBeenCalledWith("t1");
    expect(put).toHaveBeenCalledWith(key, JSON.stringify(stateRows));
    expect(warnings.join("\n")).toContain("Pre-deploy snapshot captured for d1");
  });

  it("simulates upload when no snapshotStore is injected (original behavior)", async () => {
    const sim = createDeploymentSnapshot({
      stateSource: { fetchState },
      decisionLog: { insert: async () => undefined },
      warn: (m) => warnings.push(m),
      now: () => 42,
    });
    const key = await sim.capturePreDeploySnapshot("t1", "d2");
    expect(key).toBe("snapshots/t1/d2-42.json");
    expect(put).not.toHaveBeenCalled();
  });

  it("should record a decision-log entry on rollback", async () => {
    await snapshot.rollbackFromSnapshot("t1", "snapshots/t1/d1-1700000000000.json");

    expect(inserted).toHaveLength(1);
    const entry = inserted[0]!;
    expect(entry.tenant_id).toBe("t1");
    expect(entry.decision_type).toBe("stop");
    expect(entry.source).toBe("manual");
    expect(entry.resource_type).toBe("snapshot");
    expect(entry.resource_id).toBe("d1-1700000000000.json");
    expect(entry.subject).toContain("System Rollback:");
    expect(entry.metadata).toEqual({
      method: "1-click-rollback",
      snapshot_key: "snapshots/t1/d1-1700000000000.json",
    });
    expect(warnings.join("\n")).toContain("Reverting tenant t1");
  });

  it("falls back to the full key as resource_id when the key has no path segments", async () => {
    await snapshot.rollbackFromSnapshot("t1", "flat-key");
    expect(inserted[0]!.resource_id).toBe("flat-key");
  });

  it("round-trip: capture then rollback references the same key", async () => {
    const key = await snapshot.capturePreDeploySnapshot("t9", "deploy-9");
    await snapshot.rollbackFromSnapshot("t9", key);
    expect(inserted[0]!.metadata.snapshot_key).toBe(key);
  });
});
