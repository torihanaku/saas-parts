/**
 * Ad-insights forecast data source (ported from 実運用SaaS
 * server/lib/marketing/data-sources/supabase-ad-insights.ts).
 *
 * The original queried Supabase directly. Here the raw row loader is injected
 * as `AdInsightLoader`; the date-aggregation logic (the reusable part) is
 * ported faithfully.
 */

import type { ForecastDataSource, ForecastDataPoint, FetchDailySeriesParams } from "../data-source";

export interface RawAdInsightRow {
  date: string;
  spend_jpy?: number;
  revenue_jpy?: number;
  conversions?: number;
  clicks?: number;
  impressions?: number;
}

/** Loads raw ad-insight rows for the given query (injected). */
export type AdInsightLoader = (params: FetchDailySeriesParams) => Promise<RawAdInsightRow[]>;

export class AdInsightsDataSource implements ForecastDataSource {
  kind = "supabase_ad_insights" as const;

  constructor(private load: AdInsightLoader) {}

  async fetchDailySeries(params: FetchDailySeriesParams): Promise<ForecastDataPoint[]> {
    const rows = await this.load(params);

    const aggregated = new Map<string, ForecastDataPoint>();
    for (const row of rows || []) {
      const date = String(row.date);
      const spend = Number(row.spend_jpy || 0);
      const revenue = Number(row.revenue_jpy || 0);
      const conversions = Number(row.conversions || 0);
      const clicks = Number(row.clicks || 0);
      const impressions = Number(row.impressions || 0);

      const existing = aggregated.get(date);
      if (existing) {
        existing.spend += spend;
        existing.revenue += revenue;
        existing.conversions += conversions;
        existing.clicks = (existing.clicks || 0) + clicks;
        existing.impressions = (existing.impressions || 0) + impressions;
      } else {
        aggregated.set(date, { date, spend, revenue, conversions, clicks, impressions });
      }
    }

    return Array.from(aggregated.values()).sort((a, b) => a.date.localeCompare(b.date));
  }
}

/** Factory for the registry. `config` unused; the loader is closed over. */
export function adInsightsFactory(load: AdInsightLoader) {
  return (_config: unknown): ForecastDataSource => new AdInsightsDataSource(load);
}
