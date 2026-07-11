/**
 * Greedy budget reallocation suggester (ported from dev-dashboard-v2
 * server/lib/marketing/budget-optimizer.ts).
 *
 * MVP heuristic: rank campaigns by historical ROAS, give the top performers
 * more budget and taper the rest. The original fetched `ad_insights` from
 * Supabase; here the raw rows are passed in (or fetched via an injected loader)
 * so the package is self-contained.
 */

import type { AdPlatform } from "./types";

export interface CampaignInsightRow {
  platform: string;
  campaign_id: string;
  spend_jpy: number;
  revenue_jpy: number;
  conversions: number;
}

export interface BudgetSuggestion {
  platform: AdPlatform;
  campaignId: string;
  currentDailyBudgetJpy: number;
  suggestedDailyBudgetJpy: number;
  expectedLiftRoas: number;
  rationale: string;
}

export interface SuggestBudgetResult {
  suggestions: BudgetSuggestion[];
  totalSuggestedBudget: number;
  confidence: number;
}

const VALID_PLATFORMS: AdPlatform[] = ["meta", "google", "linkedin", "tiktok"];

/**
 * Suggest a budget reallocation from raw ad-insight rows.
 *
 * @param rows      recent ad_insights rows (e.g. last 30 days)
 * @param constraints total daily budget + horizon
 */
export function suggestBudgetReallocation(
  rows: CampaignInsightRow[],
  constraints: { totalBudgetJpy: number; horizonDays: number },
): SuggestBudgetResult {
  if (!rows || rows.length === 0) {
    return { suggestions: [], totalSuggestedBudget: 0, confidence: 0 };
  }

  const campaignStats = new Map<string, { platform: string; spend: number; revenue: number; conv: number }>();
  for (const row of rows) {
    const key = `${row.platform}:${row.campaign_id}`;
    const existing = campaignStats.get(key) || { platform: row.platform, spend: 0, revenue: 0, conv: 0 };
    existing.spend += Number(row.spend_jpy || 0);
    existing.revenue += Number(row.revenue_jpy || 0);
    existing.conv += Number(row.conversions || 0);
    campaignStats.set(key, existing);
  }

  const suggestions: BudgetSuggestion[] = [];
  let totalSuggested = 0;

  const campaigns = Array.from(campaignStats.entries()).filter(([, stats]) =>
    VALID_PLATFORMS.includes(stats.platform as AdPlatform),
  );
  if (campaigns.length === 0) return { suggestions: [], totalSuggestedBudget: 0, confidence: 0 };

  const scored = campaigns
    .map(([key, stats]) => {
      const roas = stats.spend > 0 ? stats.revenue / stats.spend : 0;
      const currentDaily = stats.spend / 30;
      return { key, stats, roas, currentDaily };
    })
    .sort((a, b) => b.roas - a.roas);

  let remainingBudget = constraints.totalBudgetJpy;

  scored.forEach((item, index) => {
    const [platform, campaignId] = item.key.split(":");
    let suggested: number;

    if (index === 0) {
      suggested = Math.min(remainingBudget * 0.5, item.currentDaily * 1.5);
    } else if (index === 1) {
      suggested = Math.min(remainingBudget * 0.5, item.currentDaily * 1.2);
    } else {
      suggested = item.currentDaily * 0.8;
    }

    if (suggested < 500) suggested = 500;
    if (suggested > remainingBudget) suggested = remainingBudget;

    remainingBudget -= suggested;
    suggested = Math.floor(suggested);

    const lift = item.roas > 0 ? (suggested / item.currentDaily) * 0.1 : 0;

    suggestions.push({
      platform: platform as AdPlatform,
      campaignId: campaignId!,
      currentDailyBudgetJpy: Math.floor(item.currentDaily),
      suggestedDailyBudgetJpy: suggested,
      expectedLiftRoas: Number(lift.toFixed(2)),
      rationale:
        index < 2
          ? `High historical ROAS (${item.roas.toFixed(2)}). Increasing budget to maximize returns.`
          : `Underperforming compared to peers. Reallocating budget to top campaigns.`,
    });
    totalSuggested += suggested;
  });

  return { suggestions, totalSuggestedBudget: totalSuggested, confidence: 0.85 };
}
