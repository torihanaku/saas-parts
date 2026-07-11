import { describe, it, expect } from "vitest";
import {
  triggerAndWaitForSync,
  triggerSyncBatch,
  validateConnection,
  getClientConnectionStatuses,
  resolveConnectionId,
} from "./operations";
import { MockIntegrationProvider } from "./mock-provider";
import { buildConnectionId, extractClientId, isClientConnection } from "./connection-id";

const FAST = { pollIntervalMs: 1, timeoutMs: 5000 };

describe("triggerAndWaitForSync (fire-and-wait state machine)", () => {
  it("returns ok:false when trigger fails", async () => {
    const provider = new MockIntegrationProvider();
    provider.failTrigger = true;
    expect((await triggerAndWaitForSync(provider, "t1", "slack", "c1")).ok).toBe(false);
  });

  it("returns ok:true when status reaches success", async () => {
    const provider = new MockIntegrationProvider();
    provider.statusSequence = [{ status: "running" }, { status: "success" }];
    const result = await triggerAndWaitForSync(provider, "t1", "slack", "c1", undefined, FAST);
    expect(result.ok).toBe(true);
    expect(result.status).toEqual({ status: "success" });
  });

  it("accepts uppercase SUCCESS", async () => {
    const provider = new MockIntegrationProvider();
    provider.statusSequence = [{ status: "SUCCESS" }];
    expect((await triggerAndWaitForSync(provider, "t1", "slack", "c1", undefined, FAST)).ok).toBe(true);
  });

  it("returns ok:false when status reaches error", async () => {
    const provider = new MockIntegrationProvider();
    provider.statusSequence = [{ status: "error" }];
    const result = await triggerAndWaitForSync(provider, "t1", "slack", "c1", undefined, FAST);
    expect(result.ok).toBe(false);
    expect(result.status).toEqual({ status: "error" });
  });

  it("returns timeout when the deadline passes while still running", async () => {
    const provider = new MockIntegrationProvider(); // pollStatus keeps returning "running"
    const result = await triggerAndWaitForSync(provider, "t1", "slack", "c1", undefined, {
      pollIntervalMs: 1,
      timeoutMs: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
  });

  it("passes named syncs through to the provider", async () => {
    const provider = new MockIntegrationProvider();
    provider.statusSequence = [{ status: "success" }];
    await triggerAndWaitForSync(provider, "t1", "slack", "c1", ["messages"], FAST);
    expect(provider.triggerCalls[0]?.syncs).toEqual(["messages"]);
  });
});

describe("triggerSyncBatch", () => {
  it("returns zero for an empty connection list", async () => {
    const provider = new MockIntegrationProvider();
    expect(await triggerSyncBatch(provider, "t1", [])).toEqual({ total: 0, succeeded: 0, results: [] });
  });

  it("counts succeeded per connection", async () => {
    const provider = new MockIntegrationProvider();
    let call = 0;
    provider.triggerSync = async () => call++ === 0; // 1回目のみ成功
    const result = await triggerSyncBatch(provider, "t1", [
      { integrationId: "slack", connectionId: "cs" },
      { integrationId: "github", connectionId: "cg" },
    ]);
    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
  });
});

describe("validateConnection", () => {
  it("returns true when the connection exists on the provider", async () => {
    const provider = new MockIntegrationProvider();
    provider.addConnection("c1", "slack");
    expect(await validateConnection(provider, "t1", "slack", "c1")).toBe(true);
  });

  it("returns false when not found", async () => {
    const provider = new MockIntegrationProvider();
    provider.addConnection("other", "slack");
    expect(await validateConnection(provider, "t1", "slack", "c1")).toBe(false);
  });
});

describe("getClientConnectionStatuses", () => {
  it("returns empty array when the client has no connections", async () => {
    const provider = new MockIntegrationProvider();
    expect(await getClientConnectionStatuses(provider, "t1", "clientA")).toEqual([]);
  });

  it("returns per-connection status including last sync", async () => {
    const provider = new MockIntegrationProvider();
    provider.addConnection(buildConnectionId("clientA", "slack"), "slack");
    provider.statusSequence = [{ status: "success" }];
    const result = await getClientConnectionStatuses(provider, "t1", "clientA");
    expect(result).toHaveLength(1);
    expect(result[0]?.connected).toBe(true);
    expect(result[0]?.integrationId).toBe("slack");
    expect(result[0]?.lastSyncStatus).toEqual({ status: "success" });
  });

  it("tolerates pollStatus errors (null lastSyncStatus)", async () => {
    const provider = new MockIntegrationProvider();
    provider.addConnection(buildConnectionId("clientA", "slack"), "slack");
    provider.pollStatus = async () => {
      throw new Error("boom");
    };
    const result = await getClientConnectionStatuses(provider, "t1", "clientA");
    expect(result[0]?.lastSyncStatus).toBeNull();
  });
});

describe("connection-id convention", () => {
  it("builds and resolves client-scoped connection IDs", () => {
    expect(resolveConnectionId("clientABC", "slack")).toBe("client_clientABC_slack");
    expect(buildConnectionId("clientABC", "slack")).toBe("client_clientABC_slack");
  });

  it("extracts the client ID (null for non-scoped)", () => {
    expect(extractClientId("client_abc_slack")).toBe("abc");
    expect(extractClientId("plain-connection")).toBeNull();
  });

  it("checks ownership", () => {
    expect(isClientConnection("client_abc_slack", "abc")).toBe(true);
    expect(isClientConnection("client_abc_slack", "xyz")).toBe(false);
  });
});
