import { describe, it, expect } from "vitest";
import { suggestBudgetReallocation, type CampaignInsightRow } from "./suggest-allocation";

describe("suggestBudgetReallocation", () => {
  it("returns empty when no rows", () => {
    expect(suggestBudgetReallocation([], { totalBudgetJpy: 100_000, horizonDays: 30 })).toEqual({
      suggestions: [],
      totalSuggestedBudget: 0,
      confidence: 0,
    });
  });

  it("ignores unknown platforms", () => {
    const rows: CampaignInsightRow[] = [{ platform: "rakuten", campaign_id: "c1", spend_jpy: 1000, revenue_jpy: 5000, conversions: 3 }];
    const res = suggestBudgetReallocation(rows, { totalBudgetJpy: 100_000, horizonDays: 30 });
    expect(res.suggestions).toHaveLength(0);
    expect(res.confidence).toBe(0);
  });

  it("ranks by ROAS and gives top performer more budget", () => {
    const rows: CampaignInsightRow[] = [
      { platform: "google", campaign_id: "hi", spend_jpy: 30_000, revenue_jpy: 120_000, conversions: 40 },
      { platform: "meta", campaign_id: "lo", spend_jpy: 30_000, revenue_jpy: 15_000, conversions: 5 },
    ];
    const res = suggestBudgetReallocation(rows, { totalBudgetJpy: 100_000, horizonDays: 30 });
    expect(res.suggestions).toHaveLength(2);
    expect(res.suggestions[0]!.campaignId).toBe("hi"); // higher ROAS ranked first
    expect(res.confidence).toBe(0.85);
    expect(res.totalSuggestedBudget).toBeGreaterThan(0);
    // Every suggestion respects the 500 JPY floor
    for (const s of res.suggestions) expect(s.suggestedDailyBudgetJpy).toBeGreaterThanOrEqual(500);
  });
});
