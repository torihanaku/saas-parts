import { describe, it, expect } from "vitest";
import { runBudgetTriggerDetection } from "./detection-cron";
import { InMemoryReallocationStore } from "./store";
import type { AdInsightRow } from "./types";

function dateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
function insight(o: Partial<AdInsightRow> & { tenant_id: string }): AdInsightRow {
  return { date: dateDaysAgo(1), platform: "google", campaign_id: "camp-1", spend_jpy: 0, revenue_jpy: 0, conversions: 0, ...o } as AdInsightRow;
}

const on = () => true;
const off = () => false;

describe("runBudgetTriggerDetection", () => {
  it("returns disabled when flag OFF", async () => {
    const store = new InMemoryReallocationStore();
    const r = await runBudgetTriggerDetection({ store, isEnabled: off });
    expect(r.status).toBe("disabled");
    expect(r.tenantsScanned).toBe(0);
  });

  it("returns 0 proposals when no tenants have ad_insights", async () => {
    const store = new InMemoryReallocationStore({ adInsights: [] });
    const r = await runBudgetTriggerDetection({ store, isEnabled: on });
    expect(r.status).toBe("ran");
    expect(r.tenantsScanned).toBe(0);
  });

  it("proposes & records when trigger detected and no duplicate", async () => {
    // Build a CPA spike for google camp-1 in tenant T
    const T = "11111111-1111-1111-1111-111111111111";
    const store = new InMemoryReallocationStore({
      adInsights: [
        insight({ tenant_id: T, date: dateDaysAgo(10), platform: "google", campaign_id: "camp-1", spend_jpy: 100_000, revenue_jpy: 200_000, conversions: 10, daily_budget_jpy: 10_000 }),
        insight({ tenant_id: T, date: dateDaysAgo(1), platform: "google", campaign_id: "camp-1", spend_jpy: 100_000, revenue_jpy: 50_000, conversions: 5, daily_budget_jpy: 10_000 }),
      ],
    });
    const r = await runBudgetTriggerDetection({ store, isEnabled: on });
    expect(r.status).toBe("ran");
    expect(r.tenantsScanned).toBe(1);
    expect(r.triggersDetected).toBeGreaterThanOrEqual(1);
    expect(r.proposalsCreated).toBeGreaterThanOrEqual(1);
  });

  it("skips duplicate within cooldown window", async () => {
    const T = "22222222-2222-2222-2222-222222222222";
    const store = new InMemoryReallocationStore({
      adInsights: [
        insight({ tenant_id: T, date: dateDaysAgo(10), platform: "google", campaign_id: "camp-1", spend_jpy: 100_000, revenue_jpy: 200_000, conversions: 10, daily_budget_jpy: 10_000 }),
        insight({ tenant_id: T, date: dateDaysAgo(1), platform: "google", campaign_id: "camp-1", spend_jpy: 100_000, revenue_jpy: 50_000, conversions: 5, daily_budget_jpy: 10_000 }),
      ],
      // Seed dupes for both trigger types this fixture produces (CPA spike + ROAS drop).
      reallocations: [
        { id: "dup1", tenantId: T, status: "proposed", sourcePlatform: "google", sourceCampaignId: "camp-1", triggerType: "cpa_spike", proposedAt: new Date().toISOString(), proposedDailyBudgetJpy: 8_500 },
        { id: "dup2", tenantId: T, status: "proposed", sourcePlatform: "google", sourceCampaignId: "camp-1", triggerType: "roas_drop", proposedAt: new Date().toISOString(), proposedDailyBudgetJpy: 8_500 },
      ],
    });
    const r = await runBudgetTriggerDetection({ store, isEnabled: on });
    expect(r.duplicatesSkipped).toBeGreaterThanOrEqual(1);
    expect(r.proposalsCreated).toBe(0);
  });
});
