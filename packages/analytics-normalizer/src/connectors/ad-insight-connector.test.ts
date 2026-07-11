import { describe, it, expect, vi } from "vitest";
import {
  createLinkedinConnector,
  createTiktokConnector,
  type ConnectorClient,
} from "./ad-insight-connector";

function makeClient(over: Partial<ConnectorClient> = {}): ConnectorClient {
  return {
    listConnections: vi.fn().mockResolvedValue([]),
    listRecords: vi.fn().mockResolvedValue({ records: [] }),
    ...over,
  };
}

describe("createLinkedinConnector", () => {
  it("returns 0 inserts when no matching connection", async () => {
    const client = makeClient({ listConnections: vi.fn().mockResolvedValue([{ connection_id: "x", provider_config_key: "tiktok-ads" }]) });
    const insert = vi.fn();
    const connector = createLinkedinConnector({ client, insert });
    const r = await connector.sync("t1", "2026-04-01", "2026-04-07");
    expect(r.inserted).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("auto-discovers the linkedin connection and normalizes+inserts records", async () => {
    const client = makeClient({
      listConnections: vi.fn().mockResolvedValue([{ connection_id: "conn-1", provider_config_key: "linkedin-ads", provider: "linkedin" }]),
      listRecords: vi.fn().mockResolvedValue({
        records: [{ campaignId: "camp-1", spend: "1200", conversions: 4, clicks: 30 }],
      }),
    });
    const insert = vi.fn().mockResolvedValue(undefined);
    const connector = createLinkedinConnector({ client, insert });
    const r = await connector.sync("t1", "2026-04-01", "2026-04-07");
    expect(r.inserted).toBe(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t1",
        platform: "linkedin",
        campaign_id: "camp-1",
        spend_jpy: 1200,
        conversions: 4,
        clicks: 30,
        date: "2026-04-01",
      }),
    );
  });

  it("honors explicit connection/integration ids", async () => {
    const client = makeClient({ listRecords: vi.fn().mockResolvedValue({ records: [{ id: "r1" }] }) });
    const listConnections = client.listConnections as ReturnType<typeof vi.fn>;
    const insert = vi.fn().mockResolvedValue(undefined);
    const connector = createLinkedinConnector({ client, insert });
    await connector.sync("t1", "2026-04-01", "2026-04-07", { connectionId: "c", integrationId: "i" });
    expect(listConnections).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ campaign_id: "r1" }));
  });

  it("recovers and logs when listRecords throws", async () => {
    const client = makeClient({
      listConnections: vi.fn().mockResolvedValue([{ connection_id: "c", provider_config_key: "linkedin-ads" }]),
      listRecords: vi.fn().mockRejectedValue(new Error("nango down")),
    });
    const logger = { error: vi.fn() };
    const connector = createLinkedinConnector({ client, insert: vi.fn(), logger });
    const r = await connector.sync("t1", "2026-04-01", "2026-04-07");
    expect(r.inserted).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("createTiktokConnector", () => {
  it("uses the tiktok platform + keyword", async () => {
    const client = makeClient({
      listConnections: vi.fn().mockResolvedValue([{ connection_id: "c", provider_config_key: "tiktok-ads" }]),
      listRecords: vi.fn().mockResolvedValue({ records: [{ campaign_id: "tt-1", spend_jpy: 900 }] }),
    });
    const insert = vi.fn().mockResolvedValue(undefined);
    const connector = createTiktokConnector({ client, insert });
    expect(connector.platform).toBe("tiktok");
    const r = await connector.sync("t1", "2026-04-01", "2026-04-07");
    expect(r.inserted).toBe(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ platform: "tiktok", campaign_id: "tt-1", spend_jpy: 900 }));
  });
});
