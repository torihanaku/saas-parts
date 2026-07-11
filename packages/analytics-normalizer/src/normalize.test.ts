import { describe, it, expect, vi } from "vitest";
import {
  normalizeGa4,
  normalizeGsc,
  normalizeGoogleAds,
  normalizeMetaAds,
  aggregateByPeriod,
  computeRoi,
  computeTrends,
  type NormalizedMetric,
  type SnapshotLoader,
} from "./normalize";

describe("normalizeGa4", () => {
  it("normalizes complete GA4 data", () => {
    const result = normalizeGa4([{ page_path: "/blog/ai-trends", sessions: 1200, period_start: "2026-04-01", period_end: "2026-04-07" }]);
    expect(result[0]).toEqual({ source: "ga4", metric_type: "traffic", dimension: "/blog/ai-trends", value: 1200, period_start: "2026-04-01", period_end: "2026-04-07" });
  });
  it("uses event_name / dimension fallbacks", () => {
    expect(normalizeGa4([{ event_name: "purchase", value: 42, date: "2026-04-05" }])[0]!.dimension).toBe("purchase");
    expect(normalizeGa4([{ dimension: "organic", pageviews: 300, date: "2026-04-01" }])[0]!.value).toBe(300);
  });
  it("handles missing fields and empty input", () => {
    expect(normalizeGa4([{}])[0]).toEqual({ source: "ga4", metric_type: "traffic", dimension: "unknown", value: 0, period_start: "", period_end: "" });
    expect(normalizeGa4([])).toEqual([]);
  });
  it("detects metric types", () => {
    expect(normalizeGa4([{ page_path: "/c", conversions: 15 }])[0]!.metric_type).toBe("conversion");
    expect(normalizeGa4([{ page_path: "/a", cost: 500 }])[0]!.metric_type).toBe("cost");
    expect(normalizeGa4([{ page_path: "/s", position: 3 }])[0]!.metric_type).toBe("ranking");
  });
});

describe("normalizeGsc", () => {
  it("normalizes with metadata", () => {
    const result = normalizeGsc([{ query: "ai dashboard", clicks: 150, impressions: 3000, ctr: 0.05, position: 4.2, period_start: "2026-04-01", period_end: "2026-04-07" }]);
    expect(result[0]).toEqual({ source: "gsc", metric_type: "ranking", dimension: "ai dashboard", value: 150, period_start: "2026-04-01", period_end: "2026-04-07", metadata: { impressions: 3000, ctr: 0.05, position: 4.2 } });
  });
  it("page fallback + missing fields", () => {
    expect(normalizeGsc([{ page: "/blog", clicks: 80 }])[0]!.dimension).toBe("/blog");
    expect(normalizeGsc([{}])[0]!.metadata).toEqual({ impressions: 0, ctr: 0, position: 0 });
  });
});

describe("normalizeGoogleAds", () => {
  it("normalizes with metadata + spend fallback", () => {
    const result = normalizeGoogleAds([{ campaign_name: "Brand", cost: 2500, clicks: 800, impressions: 50000, conversions: 25 }]);
    expect(result[0]!.value).toBe(2500);
    expect(result[0]!.metadata).toEqual({ clicks: 800, impressions: 50000, conversions: 25 });
    expect(normalizeGoogleAds([{ name: "Retargeting", spend: 1000 }])[0]!.value).toBe(1000);
  });
});

describe("normalizeMetaAds", () => {
  it("normalizes with metadata + date_start/stop fallbacks", () => {
    const result = normalizeMetaAds([{ campaign_name: "Summer", spend: 1500, impressions: 80000, clicks: 1200, reach: 60000 }]);
    expect(result[0]!.value).toBe(1500);
    expect(result[0]!.metadata).toEqual({ impressions: 80000, clicks: 1200, reach: 60000 });
    const r = normalizeMetaAds([{ name: "Fall", spend: 800, date_start: "2026-10-01", date_stop: "2026-10-07" }]);
    expect(r[0]!.period_start).toBe("2026-10-01");
    expect(r[0]!.period_end).toBe("2026-10-07");
  });
});

describe("aggregateByPeriod", () => {
  it("aggregates rows grouped by source with totals", async () => {
    const loader: SnapshotLoader = vi.fn().mockResolvedValue([
      { source: "ga4", metric_type: "traffic", dimension: "/blog", value: 500, period_start: "2026-04-01", period_end: "2026-04-07", metadata: {} },
      { source: "ga4", metric_type: "traffic", dimension: "/home", value: 300, period_start: "2026-04-01", period_end: "2026-04-07", metadata: {} },
      { source: "gsc", metric_type: "ranking", dimension: "ai tools", value: 120, period_start: "2026-04-01", period_end: "2026-04-07", metadata: {} },
    ]);
    const result = await aggregateByPeriod(loader, "proj-1", "2026-04-01", "2026-04-07");
    expect(result.period).toEqual({ start: "2026-04-01", end: "2026-04-07" });
    expect(result.metrics_by_source["ga4"]).toHaveLength(2);
    expect(result.totals["ga4:traffic"]).toBe(800);
    expect(result.totals["gsc:ranking"]).toBe(120);
    expect(result.trends).toEqual({});
    expect(loader).toHaveBeenCalledWith("proj-1", "2026-04-01", "2026-04-07");
  });
  it("empty report when loader returns [] or null", async () => {
    expect((await aggregateByPeriod(async () => [], "p", "a", "b")).totals).toEqual({});
    expect((await aggregateByPeriod(async () => null, "p", "a", "b")).metrics_by_source).toEqual({});
  });
});

describe("computeRoi", () => {
  const cost = (dim: string, v: number): NormalizedMetric => ({ source: "google-ads", metric_type: "cost", dimension: dim, value: v, period_start: "", period_end: "" });
  const conv = (dim: string, v: number): NormalizedMetric => ({ source: "ga4", metric_type: "conversion", dimension: dim, value: v, period_start: "", period_end: "" });
  it("computes ROI per dimension", () => {
    expect(computeRoi([cost("Brand", 1000)], [conv("Brand", 3000)])["Brand"]).toBe(2.0);
  });
  it("returns 0 when cost is 0, -1 when no conversions", () => {
    expect(computeRoi([cost("Organic", 0)], [conv("Organic", 500)])["Organic"]).toBe(0);
    expect(computeRoi([cost("Display", 500)], [])["Display"]).toBe(-1.0);
  });
  it("aggregates same-dimension rows; empty inputs → {}", () => {
    expect(computeRoi([cost("S", 200), cost("S", 300)], [conv("S", 1000), conv("S", 500)])["S"]).toBe(2.0);
    expect(computeRoi([], [])).toEqual({});
  });
});

describe("computeTrends", () => {
  const m = (source: NormalizedMetric["source"], type: NormalizedMetric["metric_type"], v: number): NormalizedMetric => ({ source, metric_type: type, dimension: "d", value: v, period_start: "", period_end: "" });
  it("increase / decrease", () => {
    expect(computeTrends([m("ga4", "traffic", 1000)], [m("ga4", "traffic", 800)])["ga4:traffic"]).toEqual({ current: 1000, previous: 800, change_pct: 25 });
    expect(computeTrends([m("gsc", "ranking", 50)], [m("gsc", "ranking", 100)])["gsc:ranking"]!.change_pct).toBe(-50);
  });
  it("previous=0 → change_pct 0; current-only / previous-only keys", () => {
    expect(computeTrends([m("ga4", "traffic", 500)], [m("ga4", "traffic", 0)])["ga4:traffic"]!.change_pct).toBe(0);
    expect(computeTrends([m("meta-ads", "cost", 1000)], [])["meta-ads:cost"]).toEqual({ current: 1000, previous: 0, change_pct: 0 });
    expect(computeTrends([], [m("google-ads", "cost", 2000)])["google-ads:cost"]!.change_pct).toBe(-100);
  });
  it("empty → {}", () => {
    expect(computeTrends([], [])).toEqual({});
  });
});
