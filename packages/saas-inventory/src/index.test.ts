import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSaaSInventory,
  type SaaSItem,
  type InventoryStore,
  type IntegrationStatus,
} from "./index";

function makeSaaSItem(overrides: Partial<SaaSItem> = {}): SaaSItem {
  return {
    id: "item-1",
    project_id: "proj-1",
    tool_name: "hubspot",
    category: "crm",
    status: "active",
    monthly_cost: 500,
    integration_status: "connected",
    owner: "team@example.com",
    renewal_date: "2027-01-01",
    metadata: {},
    updated_at: "2026-04-13T00:00:00Z",
    ...overrides,
  };
}

/** Configurable mock store so we can assert list/insert/patch/findByTool calls. */
function makeMockStore(listResult: SaaSItem[] = [], existing: SaaSItem | null = null) {
  const store: InventoryStore = {
    list: vi.fn(async () => listResult),
    findByTool: vi.fn(async () => existing),
    insert: vi.fn(async () => {}),
    patch: vi.fn(async () => {}),
  };
  return store;
}

let idCounter = 0;
function fixedDeps(store: InventoryStore, integrations?: () => Promise<IntegrationStatus[]>) {
  idCounter = 0;
  return {
    store,
    integrations,
    newId: () => `id-${++idCounter}`,
    now: () => "2026-05-10T00:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  idCounter = 0;
});

describe("getSaaSInventory", () => {
  it("returns items from the store", async () => {
    const items = [makeSaaSItem({ id: "i1" }), makeSaaSItem({ id: "i2", tool_name: "slack" })];
    const store = makeMockStore(items);
    const inv = createSaaSInventory(fixedDeps(store));
    const result = await inv.getSaaSInventory("proj-1");
    expect(result).toHaveLength(2);
    expect(result[0]!.tool_name).toBe("hubspot");
    expect(store.list).toHaveBeenCalledWith("proj-1");
  });
});

describe("upsertSaaSItem", () => {
  it("creates new item when none exists", async () => {
    const store = makeMockStore([], null);
    const inv = createSaaSInventory(fixedDeps(store));
    const result = await inv.upsertSaaSItem({
      project_id: "proj-1",
      tool_name: "notion",
      category: "development",
      monthly_cost: 100,
    });
    expect(result.tool_name).toBe("notion");
    expect(result.category).toBe("development");
    expect(result.monthly_cost).toBe(100);
    expect(result.status).toBe("active");
    expect(store.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tool_name: "notion", id: "id-1" }),
    );
  });

  it("updates existing item when one is found", async () => {
    const existing = makeSaaSItem({ id: "existing-1", tool_name: "slack", monthly_cost: 200 });
    const store = makeMockStore([], existing);
    const inv = createSaaSInventory(fixedDeps(store));
    const result = await inv.upsertSaaSItem({
      project_id: "proj-1",
      tool_name: "slack",
      monthly_cost: 300,
    });
    expect(result.monthly_cost).toBe(300);
    expect(store.patch).toHaveBeenCalledWith(
      "existing-1",
      expect.objectContaining({ monthly_cost: 300 }),
    );
    expect(store.insert).not.toHaveBeenCalled();
  });

  it("applies defaults for missing optional fields", async () => {
    const store = makeMockStore([], null);
    const inv = createSaaSInventory(fixedDeps(store));
    const result = await inv.upsertSaaSItem({ project_id: "proj-1", tool_name: "custom-tool" });
    expect(result.category).toBe("other");
    expect(result.status).toBe("active");
    expect(result.monthly_cost).toBe(0);
    expect(result.integration_status).toBe("disconnected");
    expect(result.owner).toBe("");
    expect(result.renewal_date).toBeNull();
  });
});

describe("detectSaaSFromIntegrations", () => {
  it("detects connected integrations and upserts", async () => {
    const store = makeMockStore([], null);
    const integrations = vi.fn(async (): Promise<IntegrationStatus[]> => [
      { integration: "hubspot", sourceType: "hubspot", connected: true, connectionCount: 1 },
      { integration: "slack", sourceType: "slack", connected: true, connectionCount: 2 },
      { integration: "salesforce", sourceType: "salesforce", connected: false, connectionCount: 0 },
    ]);
    const inv = createSaaSInventory(fixedDeps(store, integrations));
    const result = await inv.detectSaaSFromIntegrations("proj-1");
    expect(result).toHaveLength(2);
    expect(result[0]!.category).toBe("crm");
    expect(result[1]!.category).toBe("communication");
    expect(store.insert).toHaveBeenCalledTimes(2);
  });

  it("assigns 'other' category for unknown integrations and sets auto_detected", async () => {
    const store = makeMockStore([], null);
    const integrations = async (): Promise<IntegrationStatus[]> => [
      { integration: "unknown-tool", sourceType: "other", connected: true, connectionCount: 1 },
    ];
    const inv = createSaaSInventory(fixedDeps(store, integrations));
    const result = await inv.detectSaaSFromIntegrations("proj-1");
    expect(result[0]!.category).toBe("other");
    expect(result[0]!.metadata).toEqual(
      expect.objectContaining({ auto_detected: true, connection_count: 1 }),
    );
  });

  it("throws if integrations source not provided", async () => {
    const inv = createSaaSInventory(fixedDeps(makeMockStore()));
    await expect(inv.detectSaaSFromIntegrations("proj-1")).rejects.toThrow(/IntegrationSource/);
  });
});

describe("getSaaSSpendSummary", () => {
  it("returns zero when no items", async () => {
    const inv = createSaaSInventory(fixedDeps(makeMockStore([])));
    const result = await inv.getSaaSSpendSummary("proj-1");
    expect(result).toEqual({ total_monthly: 0, by_category: {} });
  });

  it("aggregates costs by category for active items only", async () => {
    const items = [
      makeSaaSItem({ tool_name: "hubspot", category: "crm", monthly_cost: 500, status: "active" }),
      makeSaaSItem({ tool_name: "salesforce", category: "crm", monthly_cost: 300, status: "active" }),
      makeSaaSItem({ tool_name: "slack", category: "communication", monthly_cost: 200, status: "active" }),
      makeSaaSItem({ tool_name: "old", category: "marketing", monthly_cost: 1000, status: "inactive" }),
      makeSaaSItem({ tool_name: "trial", category: "analytics", monthly_cost: 50, status: "trial" }),
    ];
    const inv = createSaaSInventory(fixedDeps(makeMockStore(items)));
    const result = await inv.getSaaSSpendSummary("proj-1");
    expect(result.total_monthly).toBe(1000);
    expect(result.by_category).toEqual({ crm: 800, communication: 200 });
  });
});

describe("findDuplicates", () => {
  it("groups items with the same normalized tool_name", async () => {
    const items = [
      makeSaaSItem({ id: "a", tool_name: "Slack" }),
      makeSaaSItem({ id: "b", tool_name: " slack " }),
      makeSaaSItem({ id: "c", tool_name: "notion" }),
    ];
    const inv = createSaaSInventory(fixedDeps(makeMockStore(items)));
    const dupes = await inv.findDuplicates("proj-1");
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.key).toBe("slack");
    expect(dupes[0]!.items.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });
});
