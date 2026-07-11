import { describe, it, expect, vi } from "vitest";
import {
  detectReallocationTriggers,
  proposeReallocation,
  recordReallocation,
  executeReallocation,
  getSafetyLimits,
  isSafetyCheckPassing,
  type PlatformAdapters,
} from "./reallocator";
import { InMemoryReallocationStore } from "./store";
import type { AdInsightRow, BudgetAllocationGuardrails, BudgetReallocationTrigger } from "./types";

const TENANT = "tenant-1";
const baseTrigger: BudgetReallocationTrigger = {
  type: "cpa_spike",
  description: "test",
  metric: { name: "cpa", observedValue: 18000, baselineValue: 12000, threshold: 50 },
  detectedAt: new Date().toISOString(),
};

function dateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
function insight(overrides: Partial<AdInsightRow> & { tenant_id?: string }): AdInsightRow {
  return { date: dateDaysAgo(1), platform: "meta", campaign_id: "c1", spend_jpy: 0, revenue_jpy: 0, conversions: 0, ...overrides } as AdInsightRow;
}

describe("trigger detection", () => {
  it("returns no triggers when ad_insights is empty", async () => {
    const store = new InMemoryReallocationStore({ adInsights: [] });
    expect(await detectReallocationTriggers(store, TENANT)).toHaveLength(0);
  });

  it("returns no triggers for unknown platforms", async () => {
    const store = new InMemoryReallocationStore({
      adInsights: [insight({ platform: "rakuten", spend_jpy: 1000, revenue_jpy: 5000, conversions: 10 })],
    });
    expect(await detectReallocationTriggers(store, TENANT)).toHaveLength(0);
  });

  it("detects CPA spike when CPA exceeds baseline by >=50%", async () => {
    const store = new InMemoryReallocationStore({
      adInsights: [
        insight({ date: dateDaysAgo(10), platform: "meta", campaign_id: "c1", spend_jpy: 100_000, revenue_jpy: 200_000, conversions: 10 }),
        insight({ date: dateDaysAgo(1), platform: "meta", campaign_id: "c1", spend_jpy: 100_000, revenue_jpy: 50_000, conversions: 5 }),
      ],
    });
    const res = await detectReallocationTriggers(store, TENANT);
    expect(res.some((t) => t.type === "cpa_spike")).toBe(true);
    expect(res.find((t) => t.type === "cpa_spike")?.metric.baselineValue).toBe(10_000);
  });

  it("detects ROAS drop when ROAS down by >=30%", async () => {
    const store = new InMemoryReallocationStore({
      adInsights: [
        insight({ date: dateDaysAgo(10), platform: "google", campaign_id: "c2", spend_jpy: 10_000, revenue_jpy: 20_000, conversions: 8 }),
        insight({ date: dateDaysAgo(1), platform: "google", campaign_id: "c2", spend_jpy: 10_000, revenue_jpy: 8_000, conversions: 8 }),
      ],
    });
    const res = await detectReallocationTriggers(store, TENANT);
    expect(res.some((t) => t.type === "roas_drop")).toBe(true);
    expect(res.find((t) => t.type === "roas_drop")?.metric.baselineValue).toBe(2);
  });

  it("does not synthesize triggers when baseline window is missing", async () => {
    const store = new InMemoryReallocationStore({
      adInsights: [insight({ date: dateDaysAgo(1), platform: "meta", campaign_id: "c1", spend_jpy: 100_000, revenue_jpy: 50_000, conversions: 5 })],
    });
    expect(await detectReallocationTriggers(store, TENANT)).toHaveLength(0);
  });
});

describe("safety limits", () => {
  it("falls back to defaults when no row exists", async () => {
    const store = new InMemoryReallocationStore();
    const limits = await getSafetyLimits(store, TENANT);
    expect(limits.maxDailyShiftPct).toBe(20);
    expect(limits.maxAbsoluteShiftJpy).toBe(100_000);
    expect(limits.allowAutoApply).toBe(false);
  });

  it("blocks proposal exceeding maxDailyShiftPct", async () => {
    const store = new InMemoryReallocationStore({ safetyLimits: { [TENANT]: { maxDailyShiftPct: 10 } } });
    const guardrails: BudgetAllocationGuardrails = { envEnabled: true, featureEnabled: true, tenantAllowsAutoApply: true };
    const proposal = await proposeReallocation(store, TENANT, baseTrigger, { platform: "meta", campaignId: "c1", currentDailyBudgetJpy: 10_000 }, { platform: "google", campaignId: "c2" }, 15_000, "shift +50%", guardrails);
    expect(proposal.safetyCheck.withinDailyCap).toBe(false);
    expect(proposal.safetyCheck.limitsHit).toContain("maxDailyShiftPct");
    expect(proposal.mode).toBe("propose_only");
  });

  it("blocks proposal exceeding maxAbsoluteShiftJpy", async () => {
    const store = new InMemoryReallocationStore({ safetyLimits: { [TENANT]: { maxAbsoluteShiftJpy: 5_000 } } });
    const guardrails: BudgetAllocationGuardrails = { envEnabled: true, featureEnabled: true, tenantAllowsAutoApply: true };
    const proposal = await proposeReallocation(store, TENANT, baseTrigger, { platform: "meta", campaignId: "c1", currentDailyBudgetJpy: 100_000 }, { platform: "google", campaignId: "c2" }, 110_000, "shift", guardrails);
    expect(proposal.safetyCheck.withinAbsoluteCap).toBe(false);
    expect(proposal.safetyCheck.limitsHit).toContain("maxAbsoluteShiftJpy");
  });

  it("blocks proposal violating cooldown window", async () => {
    const store = new InMemoryReallocationStore({
      safetyLimits: { [TENANT]: { maxDailyShiftPct: 50, maxAbsoluteShiftJpy: 1_000_000, cooldownMinutes: 30, allowAutoApply: true } },
      reallocations: [{ id: "prev", tenantId: TENANT, status: "proposed", sourcePlatform: "meta", sourceCampaignId: "c1", triggerType: "cpa_spike", proposedAt: new Date().toISOString(), proposedDailyBudgetJpy: 10_000 }],
    });
    const guardrails: BudgetAllocationGuardrails = { envEnabled: true, featureEnabled: true, tenantAllowsAutoApply: true };
    const proposal = await proposeReallocation(store, TENANT, baseTrigger, { platform: "meta", campaignId: "c1", currentDailyBudgetJpy: 10_000 }, { platform: "google", campaignId: "c2" }, 11_000, "small shift", guardrails);
    expect(proposal.safetyCheck.withinCooldown).toBe(false);
    expect(proposal.safetyCheck.limitsHit).toContain("cooldownMinutes");
  });

  it("isSafetyCheckPassing requires all three true", () => {
    const now = new Date().toISOString();
    expect(isSafetyCheckPassing({ withinDailyCap: true, withinAbsoluteCap: true, withinCooldown: true, limitsHit: [], computedAt: now })).toBe(true);
    expect(isSafetyCheckPassing({ withinDailyCap: false, withinAbsoluteCap: true, withinCooldown: true, limitsHit: ["maxDailyShiftPct"], computedAt: now })).toBe(false);
  });
});

describe("opt-in / propose_only default", () => {
  const guardOK: BudgetAllocationGuardrails = { envEnabled: true, featureEnabled: true, tenantAllowsAutoApply: true };
  function storeWith(allowAutoApply: boolean) {
    return new InMemoryReallocationStore({ safetyLimits: { [TENANT]: { allowAutoApply, maxDailyShiftPct: 50, maxAbsoluteShiftJpy: 1_000_000 } } });
  }

  it("forces propose_only when envEnabled=false", async () => {
    const proposal = await proposeReallocation(storeWith(true), TENANT, baseTrigger, { platform: "meta", campaignId: "c1", currentDailyBudgetJpy: 10_000 }, { platform: "google", campaignId: "c2" }, 11_000, "ok", { ...guardOK, envEnabled: false });
    expect(proposal.mode).toBe("propose_only");
  });

  it("forces propose_only when tenant allow=false", async () => {
    const proposal = await proposeReallocation(storeWith(false), TENANT, baseTrigger, { platform: "meta", campaignId: "c1", currentDailyBudgetJpy: 10_000 }, { platform: "google", campaignId: "c2" }, 11_000, "ok", { ...guardOK, tenantAllowsAutoApply: false });
    expect(proposal.mode).toBe("propose_only");
  });

  it("allows auto_apply only when everything is green", async () => {
    const proposal = await proposeReallocation(storeWith(true), TENANT, baseTrigger, { platform: "meta", campaignId: "c1", currentDailyBudgetJpy: 10_000 }, { platform: "google", campaignId: "c2" }, 11_000, "ok", guardOK);
    expect(proposal.mode).toBe("auto_apply");
  });
});

describe("persistence + execution", () => {
  const guardOK: BudgetAllocationGuardrails = { envEnabled: true, featureEnabled: true, tenantAllowsAutoApply: true };

  it("recordReallocation persists with status=proposed", async () => {
    const store = new InMemoryReallocationStore();
    const res = await recordReallocation(store, TENANT, {
      trigger: baseTrigger, mode: "propose_only",
      source: { platform: "meta", campaignId: "c1" }, target: { platform: "google", campaignId: "c2" },
      currentDailyBudgetJpy: 10_000, proposedDailyBudgetJpy: 11_000, deltaJpy: 1_000, expectedLiftRoas: 0.1, rationale: "r",
      safetyCheck: { withinDailyCap: true, withinAbsoluteCap: true, withinCooldown: true, limitsHit: [], computedAt: "" },
    }, "user@test.com");
    expect(res.ok).toBe(true);
    const row = await store.getReallocation(TENANT, res.id!);
    expect(row?.status).toBe("proposed");
  });

  it("executeReallocation rejects when feature flag off", async () => {
    const store = new InMemoryReallocationStore();
    const res = await executeReallocation(store, {}, TENANT, "rid", { email: "admin@test" }, { envEnabled: false, featureEnabled: false, tenantAllowsAutoApply: false });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("feature_disabled");
  });

  it("executeReallocation rejects when safety check failed", async () => {
    const store = new InMemoryReallocationStore({
      reallocations: [{ id: "rid", tenantId: TENANT, status: "proposed", sourcePlatform: "meta", sourceCampaignId: "c1", triggerType: "cpa_spike", proposedAt: "", proposedDailyBudgetJpy: 12_000, safetyCheck: { withinDailyCap: false, withinAbsoluteCap: true, withinCooldown: true, limitsHit: ["maxDailyShiftPct"], computedAt: "" } }],
    });
    const res = await executeReallocation(store, {}, TENANT, "rid", { email: "admin@test" }, guardOK);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("safety_check_failed");
  });

  it("executeReallocation dispatches to the matching adapter + marks executed", async () => {
    const metaAdapter = vi.fn().mockResolvedValue({ ok: true, platform: "meta_ads", campaignId: "c1" });
    const adapters: PlatformAdapters = { meta: metaAdapter };
    const store = new InMemoryReallocationStore({
      reallocations: [{ id: "rid", tenantId: TENANT, status: "proposed", sourcePlatform: "meta", sourceCampaignId: "c1", triggerType: "cpa_spike", proposedAt: "", proposedDailyBudgetJpy: 12_000, safetyCheck: { withinDailyCap: true, withinAbsoluteCap: true, withinCooldown: true, limitsHit: [], computedAt: "" } }],
    });
    const res = await executeReallocation(store, adapters, TENANT, "rid", { email: "admin@test" }, guardOK);
    expect(res.ok).toBe(true);
    expect(res.status).toBe("executed");
    expect(metaAdapter).toHaveBeenCalledTimes(1);
    const row = await store.getReallocation(TENANT, "rid");
    expect(row?.status).toBe("executed");
    expect(row?.externalRef).toBe("meta-c1");
  });

  it("executeReallocation marks failed when adapter fails", async () => {
    const adapters: PlatformAdapters = { google: vi.fn().mockResolvedValue({ ok: false, platform: "google_ads", campaignId: "c1", error: "nango_proxy_failed" }) };
    const store = new InMemoryReallocationStore({
      reallocations: [{ id: "gid", tenantId: TENANT, status: "proposed", sourcePlatform: "google", sourceCampaignId: "c1", triggerType: "cpa_spike", proposedAt: "", proposedDailyBudgetJpy: 30_000, safetyCheck: { withinDailyCap: true, withinAbsoluteCap: true, withinCooldown: true, limitsHit: [], computedAt: "" } }],
    });
    const res = await executeReallocation(store, adapters, TENANT, "gid", { email: "admin@test" }, guardOK);
    expect(res.ok).toBe(false);
    expect(res.status).toBe("failed");
  });
});
