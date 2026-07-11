import { describe, it, expect } from "vitest";
import { summarizeSyncStatuses } from "./status-summary";

describe("summarizeSyncStatuses", () => {
  it("returns zeros for an empty list", () => {
    expect(summarizeSyncStatuses([]).summary).toEqual({ total: 0, healthy: 0, error: 0, pending: 0 });
  });

  it("classifies success/error/other into healthy/error/pending", () => {
    const { summary } = summarizeSyncStatuses([
      { id: "1", integration_id: "slack", connection_id: "c1", status: "success" },
      { id: "2", integration_id: "jira", connection_id: "c2", status: "error" },
      { id: "3", integration_id: "notion", connection_id: "c3", status: "running" },
      { id: "4", integration_id: "gmail", connection_id: "c4", status: null },
    ]);
    expect(summary).toEqual({ total: 4, healthy: 1, error: 1, pending: 2 });
  });

  it("normalizes missing fields (status→pending, record_count→0, last_sync_at→null)", () => {
    const { connections } = summarizeSyncStatuses([
      { id: "1", integration_id: "slack", connection_id: "c1" },
    ]);
    expect(connections[0]).toEqual({
      id: "1",
      integration_id: "slack",
      connection_id: "c1",
      scope_id: null,
      last_sync_at: null,
      status: "pending",
      record_count: 0,
    });
  });
});
