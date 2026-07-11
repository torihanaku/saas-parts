import { describe, it, expect } from "vitest";
import { SyncEngine, type RecordSink } from "./sync-engine";
import { createExampleRegistry, type NormalizedRecord } from "./normalizers";
import { MockIntegrationProvider } from "./mock-provider";
import { triggerAndWaitForSync } from "./operations";
import { buildConnectionId } from "./connection-id";

function makeSink(existing: string[] = []): RecordSink & { inserted: NormalizedRecord[] } {
  const inserted: NormalizedRecord[] = [];
  return {
    inserted,
    async exists({ externalId }) {
      return existing.includes(externalId);
    },
    async insert(record) {
      inserted.push(record);
    },
  };
}

describe("SyncEngine.syncConnection", () => {
  it("fetches, normalizes and stores records with scope/sourceType applied", async () => {
    const provider = new MockIntegrationProvider();
    provider.recordsByModel.set("messages", [
      { id: "1", text: "hello", channel: "#general", user: "U1", ts: "1.0" },
      { id: "2", text: "world", channel: "#dev", user: "U2", ts: "2.0" },
    ]);
    const sink = makeSink();
    const engine = new SyncEngine({ provider, sink, registry: createExampleRegistry() });

    const outcome = await engine.syncConnection("t1", "slack", "c1", "proj-1");
    expect(outcome).toEqual({ integration: "slack", connectionId: "c1", recordsSynced: 2 });
    expect(sink.inserted[0]?.scope_id).toBe("proj-1");
    expect(sink.inserted[0]?.source_type).toBe("slack");
  });

  it("skips records whose external_id already exists (upsert)", async () => {
    const provider = new MockIntegrationProvider();
    provider.recordsByModel.set("messages", [
      { id: "1", text: "old", ts: "1.0" },
      { id: "2", text: "new", ts: "2.0" },
    ]);
    const sink = makeSink(["1.0"]);
    const engine = new SyncEngine({ provider, sink, registry: createExampleRegistry() });

    const outcome = await engine.syncConnection("t1", "slack", "c1", "proj-1");
    expect(outcome.recordsSynced).toBe(1);
    expect(sink.inserted[0]?.external_id).toBe("2.0");
  });

  it("skips records rejected by the injected consent gate", async () => {
    const provider = new MockIntegrationProvider();
    provider.recordsByModel.set("messages", [
      { id: "1", text: "keep", user: "U_OK", ts: "1.0" },
      { id: "2", text: "drop", user: "U_NG", ts: "2.0" },
    ]);
    const sink = makeSink();
    const engine = new SyncEngine({
      provider,
      sink,
      registry: createExampleRegistry(),
      consentGate: async ({ record }) => record.user !== "U_NG",
    });

    const outcome = await engine.syncConnection("t1", "slack", "c1", "proj-1");
    expect(outcome.recordsSynced).toBe(1);
    expect(sink.inserted[0]?.content).toContain("keep");
  });

  it("skips records the normalizer rejects (null)", async () => {
    const provider = new MockIntegrationProvider();
    provider.recordsByModel.set("messages", [{ id: "1", channel: "#x" }]); // text なし → null
    const sink = makeSink();
    const engine = new SyncEngine({ provider, sink, registry: createExampleRegistry() });
    expect((await engine.syncConnection("t1", "slack", "c1", "p1")).recordsSynced).toBe(0);
  });

  it("uses the generic fallback for unregistered integrations", async () => {
    const provider = new MockIntegrationProvider();
    provider.recordsByModel.set("records", [{ id: "1", title: "Doc", content: "Body" }]);
    const sink = makeSink();
    const engine = new SyncEngine({ provider, sink }); // 空レジストリ
    const outcome = await engine.syncConnection("t1", "unknown-tool", "c1", "p1");
    expect(outcome.recordsSynced).toBe(1);
    expect(sink.inserted[0]?.source_type).toBe("unknown-tool");
  });

  it("returns an error outcome instead of throwing", async () => {
    const provider = new MockIntegrationProvider();
    provider.fetchRecords = async () => {
      throw new Error("provider down");
    };
    const engine = new SyncEngine({ provider, sink: makeSink() });
    const outcome = await engine.syncConnection("t1", "slack", "c1", "p1");
    expect(outcome.recordsSynced).toBe(0);
    expect(outcome.error).toBe("provider down");
  });
});

describe("SyncEngine.syncAllConnections / getIntegrationStatus", () => {
  it("syncs every provider connection (optionally client-filtered)", async () => {
    const provider = new MockIntegrationProvider();
    provider.addConnection(buildConnectionId("cA", "slack"), "slack");
    provider.addConnection(buildConnectionId("cB", "slack"), "slack");
    provider.recordsByModel.set("messages", [{ id: "1", text: "hi", ts: "1.0" }]);
    const sink = makeSink();
    const engine = new SyncEngine({ provider, sink, registry: createExampleRegistry() });

    const all = await engine.syncAllConnections("t1", "p1");
    expect(all).toHaveLength(2);
    expect(sink.inserted).toHaveLength(2); // 各接続から1件ずつ
    expect(await engine.syncAllConnections("t1", "p1", "cA")).toHaveLength(1);
  });

  it("reports connection counts per registered integration", async () => {
    const provider = new MockIntegrationProvider();
    provider.addConnection("c1", "slack");
    provider.addConnection("c2", "slack");
    const engine = new SyncEngine({ provider, sink: makeSink(), registry: createExampleRegistry() });

    const status = await engine.getIntegrationStatus("t1");
    const slack = status.find((s) => s.integration === "slack");
    const ga = status.find((s) => s.integration === "google-analytics");
    expect(slack).toEqual({ integration: "slack", sourceType: "slack", connected: true, connectionCount: 2 });
    expect(ga?.connected).toBe(false);
  });
});

describe("end-to-end: connect → sync → poll → records", () => {
  it("runs the full flow against the mock provider", async () => {
    const provider = new MockIntegrationProvider();

    // 1) connect: OAuth接続セッションを作成
    const session = await provider.connect("t1", { end_user: { id: "user-1" } });
    expect(session?.token).toBe("mock_session_user-1");
    provider.addConnection(buildConnectionId("clientA", "slack"), "slack");

    // 2+3) fire-and-wait: トリガー → ポーリングで完了待ち
    provider.statusSequence = [{ status: "running" }, { status: "success" }];
    const sync = await triggerAndWaitForSync(provider, "t1", "slack", "client_clientA_slack", undefined, {
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    expect(sync.ok).toBe(true);

    // 4) records: 同期済みレコードを取り込み
    provider.recordsByModel.set("messages", [{ id: "1", text: "synced!", ts: "9.9" }]);
    const sink = makeSink();
    const engine = new SyncEngine({ provider, sink, registry: createExampleRegistry() });
    const outcome = await engine.syncConnection("t1", "slack", "client_clientA_slack", "proj-1");
    expect(outcome.recordsSynced).toBe(1);
    expect(sink.inserted[0]?.content).toContain("synced!");
  });
});
