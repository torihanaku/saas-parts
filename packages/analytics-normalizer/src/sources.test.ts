import { describe, it, expect, vi } from "vitest";
import { DataSourceRegistry } from "./data-source";
import { BigQueryDataSource, bigQueryFactory, type BigQueryConfig } from "./sources/bigquery";
import { AdInsightsDataSource, adInsightsFactory } from "./sources/ad-insights";

const bqConfig: BigQueryConfig = {
  projectId: "p",
  dataset: "d",
  table: "t",
  dateColumn: "day",
  spendColumn: "spend",
  revenueColumn: "rev",
  conversionsColumn: "conv",
};

describe("BigQueryDataSource", () => {
  it("builds parameterized SQL and maps rows", async () => {
    const exec = vi.fn().mockResolvedValue([{ date: "2026-04-01", spend: "10", revenue: "30", conversions: "3" }]);
    const src = new BigQueryDataSource(bqConfig, exec);
    const rows = await src.fetchDailySeries({ tenantId: "t1", from: "2026-04-01", to: "2026-04-07", platform: "google", campaignId: "c1" });
    expect(rows).toEqual([{ date: "2026-04-01", spend: 10, revenue: 30, conversions: 3, clicks: 0, impressions: 0 }]);
    const [query, params] = exec.mock.calls[0]!;
    expect(query).toContain("`p.d.t`");
    expect(query).toContain("AND platform = @platform");
    expect(query).toContain("AND campaign_id = @campaignId");
    expect(params).toEqual({ from: "2026-04-01", to: "2026-04-07", platform: "google", campaignId: "c1" });
  });

  it("validates required config", () => {
    expect(() => new BigQueryDataSource({ ...bqConfig, table: "" }, vi.fn())).toThrow(/table is required/);
  });
});

describe("AdInsightsDataSource", () => {
  it("aggregates rows by date and sorts ascending", async () => {
    const load = vi.fn().mockResolvedValue([
      { date: "2026-04-02", spend_jpy: 5, revenue_jpy: 10, conversions: 1, clicks: 2, impressions: 3 },
      { date: "2026-04-01", spend_jpy: 100, revenue_jpy: 200, conversions: 4 },
      { date: "2026-04-01", spend_jpy: 50, revenue_jpy: 60, conversions: 1, clicks: 7 },
    ]);
    const src = new AdInsightsDataSource(load);
    const rows = await src.fetchDailySeries({ tenantId: "t1", from: "2026-04-01", to: "2026-04-07" });
    expect(rows[0]!.date).toBe("2026-04-01");
    expect(rows[0]!.spend).toBe(150); // aggregated
    expect(rows[0]!.clicks).toBe(7);
    expect(rows[1]!.date).toBe("2026-04-02");
  });
});

describe("DataSourceRegistry", () => {
  it("registers factories and creates sources by kind", () => {
    const registry = new DataSourceRegistry()
      .register("bigquery", bigQueryFactory(vi.fn().mockResolvedValue([])))
      .register("supabase_ad_insights", adInsightsFactory(vi.fn().mockResolvedValue([])));

    expect(registry.supportedKinds().sort()).toEqual(["bigquery", "supabase_ad_insights"]);
    expect(registry.isSupported("bigquery")).toBe(true);
    expect(registry.isSupported("sheets")).toBe(false);
    expect(registry.create("bigquery", bqConfig)).toBeInstanceOf(BigQueryDataSource);
    expect(registry.create("supabase_ad_insights", {})).toBeInstanceOf(AdInsightsDataSource);
    expect(() => registry.create("csv", {})).toThrow(/Unsupported data source kind/);
  });
});
