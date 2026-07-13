/**
 * Tests for @torihanaku/abm (ported from 実運用SaaS abm-service.test.ts).
 *
 * Supabase モックを InMemoryAbmStore に、env/tenant-secrets を注入式
 * resolveApiKey に、claude-api-client を注入式 generateJson に置換。
 */
import { describe, it, expect, vi } from "vitest";

import {
  getABMAccounts,
  segmentAccounts,
  generateABMStrategy,
  syncABMAccounts,
  InMemoryAbmStore,
  DEFAULT_THRESHOLDS,
  type ABMAccount,
  type AbmConfig,
  type GenerateJson,
} from "./index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<ABMAccount> = {}): ABMAccount {
  return {
    id: "a1",
    project_id: "proj-1",
    company_name: "Acme",
    tier: "tier2",
    score: 60,
    contacts_count: 3,
    total_deal_value: 500_000,
    engagement_level: "warm",
    strategy_notes: "",
    updated_at: "2026-04-13T00:00:00Z",
    ...overrides,
  };
}

function makeConfig(opts: {
  store: InMemoryAbmStore;
  generateJson?: GenerateJson;
  resolveApiKey?: AbmConfig["resolveApiKey"];
}): AbmConfig {
  return {
    store: opts.store,
    generateJson: opts.generateJson ?? (vi.fn().mockResolvedValue({}) as unknown as GenerateJson),
    resolveApiKey: opts.resolveApiKey,
  };
}

// ─── getABMAccounts ─────────────────────────────────────────────────────────

describe("getABMAccounts", () => {
  it("returns accounts from store (score desc)", async () => {
    const store = new InMemoryAbmStore({
      accounts: [
        makeAccount({ id: "a1", company_name: "Acme", score: 60 }),
        makeAccount({ id: "a2", company_name: "Corp", score: 90 }),
      ],
    });
    const result = await getABMAccounts(makeConfig({ store }), "proj-1");
    expect(result).toHaveLength(2);
    // score desc => Corp(90) first
    expect(result[0]!.company_name).toBe("Corp");
  });

  it("returns empty array when no accounts", async () => {
    const store = new InMemoryAbmStore();
    const result = await getABMAccounts(makeConfig({ store }), "proj-1");
    expect(result).toEqual([]);
  });
});

// ─── segmentAccounts ────────────────────────────────────────────────────────

describe("segmentAccounts", () => {
  it("groups accounts into three tier segments", async () => {
    const store = new InMemoryAbmStore({
      accounts: [
        makeAccount({ id: "a1", tier: "tier1", score: 90, company_name: "Big" }),
        makeAccount({ id: "a2", tier: "tier2", score: 60, company_name: "Mid" }),
        makeAccount({ id: "a3", tier: "tier3", score: 20, company_name: "Small" }),
        makeAccount({ id: "a4", tier: "tier1", score: 85, company_name: "BigTwo" }),
      ],
    });

    const segments = await segmentAccounts(makeConfig({ store }), "proj-1");
    expect(segments).toHaveLength(3);
    expect(segments[0]!.name).toBe("Strategic Accounts (Tier 1)");
    expect(segments[0]!.accounts).toHaveLength(2);
    expect(segments[1]!.name).toBe("Growth Accounts (Tier 2)");
    expect(segments[1]!.accounts).toHaveLength(1);
    expect(segments[2]!.name).toBe("Nurture Accounts (Tier 3)");
    expect(segments[2]!.accounts).toHaveLength(1);
  });

  it("returns empty segments when no accounts exist", async () => {
    const store = new InMemoryAbmStore();
    const segments = await segmentAccounts(makeConfig({ store }), "proj-1");
    expect(segments).toHaveLength(3);
    expect(segments[0]!.accounts).toHaveLength(0);
    expect(segments[1]!.accounts).toHaveLength(0);
    expect(segments[2]!.accounts).toHaveLength(0);
  });

  it("includes correct criteria in each segment", async () => {
    const store = new InMemoryAbmStore();
    const segments = await segmentAccounts(makeConfig({ store }), "proj-1");
    expect(segments[0]!.criteria).toEqual({ tier: "tier1", min_score: 80, min_deal_value: 1_000_000 });
    expect(segments[1]!.criteria).toEqual({ tier: "tier2", min_score: 50, min_deal_value: 300_000 });
    expect(segments[2]!.criteria).toEqual({ tier: "tier3" });
  });
});

// ─── generateABMStrategy ────────────────────────────────────────────────────

describe("generateABMStrategy", () => {
  it("returns empty when account not found", async () => {
    const store = new InMemoryAbmStore();
    const result = await generateABMStrategy(makeConfig({ store }), "missing");
    expect(result.strategy).toBe("");
    expect(result.tactics).toEqual([]);
  });

  it("calls generateJson and saves strategy to account", async () => {
    const store = new InMemoryAbmStore({ accounts: [makeAccount({ id: "a1" })] });
    const generateJson = vi.fn().mockResolvedValue({
      strategy: "Focus on executive engagement and multi-threaded relationships.",
      tactics: ["Host executive dinner", "Create custom ROI report", "Schedule quarterly business review"],
    }) as unknown as GenerateJson;
    const config = makeConfig({ store, generateJson, resolveApiKey: () => "env-key" });

    const result = await generateABMStrategy(config, "a1");
    expect(result.strategy).toContain("executive engagement");
    expect(result.tactics).toHaveLength(3);
    const saved = await store.getAccountById("a1");
    expect(saved?.strategy_notes).toContain("executive engagement");
  });

  it("does not save when strategy is empty", async () => {
    const store = new InMemoryAbmStore({ accounts: [makeAccount({ id: "a1", strategy_notes: "orig" })] });
    const generateJson = vi.fn().mockResolvedValue({ strategy: "", tactics: [] }) as unknown as GenerateJson;
    const config = makeConfig({ store, generateJson, resolveApiKey: () => "env-key" });

    const result = await generateABMStrategy(config, "a1");
    expect(result.strategy).toBe("");
    const saved = await store.getAccountById("a1");
    expect(saved?.strategy_notes).toBe("orig"); // unchanged
  });

  it("handles missing fields in generateJson result", async () => {
    const store = new InMemoryAbmStore({ accounts: [makeAccount({ id: "a1" })] });
    const generateJson = vi.fn().mockResolvedValue({}) as unknown as GenerateJson;
    const config = makeConfig({ store, generateJson, resolveApiKey: () => "env-key" });

    const result = await generateABMStrategy(config, "a1");
    expect(result.strategy).toBe("");
    expect(result.tactics).toEqual([]);
  });

  it("returns fallback when no api key resolves (key gate)", async () => {
    const store = new InMemoryAbmStore({ accounts: [makeAccount({ id: "a1" })] });
    const generateJson = vi.fn().mockResolvedValue({ strategy: "x", tactics: [] }) as unknown as GenerateJson;
    const config = makeConfig({ store, generateJson, resolveApiKey: () => "" });

    const result = await generateABMStrategy(config, "a1");
    expect(result.strategy).toBe("");
    expect(generateJson).not.toHaveBeenCalled();
  });

  it("uses resolved tenant secret key (BYOK)", async () => {
    const store = new InMemoryAbmStore({ accounts: [makeAccount({ id: "a1" })] });
    const generateJson = vi.fn().mockResolvedValue({ strategy: "use tenant key", tactics: ["t1"] }) as unknown as GenerateJson;
    const resolveApiKey = vi.fn(async (tenantId: string | null) =>
      tenantId === "tenant-123" ? "tenant-secret-key" : "",
    );
    const config = makeConfig({ store, generateJson, resolveApiKey });

    await generateABMStrategy(config, "a1", "tenant-123");

    expect(resolveApiKey).toHaveBeenCalledWith("tenant-123");
    expect(generateJson).toHaveBeenCalledWith(
      "tenant-secret-key",
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
    );
  });
});

// ─── syncABMAccounts ────────────────────────────────────────────────────────

describe("syncABMAccounts", () => {
  it("returns zero when no contacts found", async () => {
    const store = new InMemoryAbmStore();
    const result = await syncABMAccounts(makeConfig({ store }), "proj-1");
    expect(result.synced).toBe(0);
  });

  it("aggregates contacts by company and creates new accounts", async () => {
    const store = new InMemoryAbmStore({
      contacts: {
        "proj-1": [
          { id: "c1", company: "Acme Inc", metadata: { lead_score: 70 } },
          { id: "c2", company: "Acme Inc", metadata: { lead_score: 60 } },
          { id: "c3", company: "Other Corp", metadata: { lead_score: 30 } },
        ],
      },
      deals: {
        "proj-1": [
          { amount: 200_000, contact_id: "c1" },
          { amount: 100_000, contact_id: "c2" },
          { amount: 50_000, contact_id: "c99" }, // filtered out
        ],
      },
    });

    const result = await syncABMAccounts(makeConfig({ store }), "proj-1");
    expect(result.synced).toBe(2);

    const accounts = store._allAccounts();
    expect(accounts).toHaveLength(2);
    const acme = accounts.find((a) => a.company_name === "Acme Inc");
    expect(acme?.total_deal_value).toBe(300_000); // c99 excluded
    expect(acme?.contacts_count).toBe(2);
  });

  it("updates existing account instead of inserting", async () => {
    const store = new InMemoryAbmStore({
      accounts: [makeAccount({ id: "existing-a1", project_id: "proj-1", company_name: "ExistingCo" })],
      contacts: { "proj-1": [{ id: "c1", company: "ExistingCo", metadata: { lead_score: 50 } }] },
      deals: { "proj-1": [] },
    });

    const result = await syncABMAccounts(makeConfig({ store }), "proj-1");
    expect(result.synced).toBe(1);

    const accounts = store._allAccounts();
    // still only 1 ExistingCo account (patched, not inserted)
    expect(accounts.filter((a) => a.company_name === "ExistingCo")).toHaveLength(1);
    expect(accounts[0]!.id).toBe("existing-a1");
  });

  it("skips contacts with empty company name", async () => {
    const store = new InMemoryAbmStore({
      contacts: {
        "proj-1": [
          { id: "c1", company: "", metadata: {} },
          { id: "c2", company: "  ", metadata: {} },
        ],
      },
    });
    const result = await syncABMAccounts(makeConfig({ store }), "proj-1");
    expect(result.synced).toBe(0);
  });
});

// ─── threshold config ────────────────────────────────────────────────────────

describe("thresholds are configurable (default = original)", () => {
  it("DEFAULT_THRESHOLDS matches original hardcoded values", () => {
    expect(DEFAULT_THRESHOLDS.tier1MinScore).toBe(80);
    expect(DEFAULT_THRESHOLDS.tier1MinDealValue).toBe(1_000_000);
    expect(DEFAULT_THRESHOLDS.tier2MinScore).toBe(50);
    expect(DEFAULT_THRESHOLDS.tier2MinDealValue).toBe(300_000);
  });

  it("custom thresholds surface in segment criteria", async () => {
    const store = new InMemoryAbmStore();
    const config: AbmConfig = {
      store,
      generateJson: vi.fn().mockResolvedValue({}) as unknown as GenerateJson,
      thresholds: { ...DEFAULT_THRESHOLDS, tier1MinScore: 95 },
    };
    const segments = await segmentAccounts(config, "proj-1");
    expect(segments[0]!.criteria).toMatchObject({ min_score: 95 });
  });
});
