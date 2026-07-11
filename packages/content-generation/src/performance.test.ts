import { describe, it, expect } from "vitest";
import {
  seededRng,
  synthesizeMetric,
  buildPerformanceReport,
  type ContentDraftLike,
} from "./performance.js";

describe("seededRng", () => {
  it("is deterministic for the same seed", () => {
    const a = seededRng("seed");
    const b = seededRng("seed");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("produces values in [0, 1)", () => {
    const r = seededRng("x");
    for (let i = 0; i < 50; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("synthesizeMetric", () => {
  it("is reproducible from the draft id", () => {
    const draft: ContentDraftLike = { id: "d1", title: "T", type: "article", created_at: "2026-01-01T00:00:00Z" };
    expect(synthesizeMetric(draft)).toEqual(synthesizeMetric(draft));
  });

  it("gives articles a higher base view range than other types", () => {
    const article = synthesizeMetric({ id: "same", title: "T", type: "article" });
    const other = synthesizeMetric({ id: "same", title: "T", type: "slack" });
    expect(article.views).toBeGreaterThan(other.views);
  });

  it("carries through the provided seo_score", () => {
    expect(synthesizeMetric({ id: "d", title: "T", seo_score: 77 }).seo_score).toBe(77);
  });
});

describe("buildPerformanceReport", () => {
  const now = new Date("2026-05-01T00:00:00Z");
  const drafts: ContentDraftLike[] = [
    { id: "a", title: "A", type: "article", created_at: "2026-01-01T00:00:00Z" },
    { id: "b", title: "B", type: "sns-x", created_at: "2026-01-02T00:00:00Z" },
    { id: "c", title: "C", type: "sns-linkedin", created_at: "2026-01-03T00:00:00Z" },
  ];

  it("aggregates overview totals", () => {
    const r = buildPerformanceReport(drafts, now);
    expect(r.overview.total_published).toBe(3);
    expect(r.overview.total_views).toBe(r.content_metrics.reduce((s, m) => s + m.views, 0));
    expect(r.content_metrics).toHaveLength(3);
  });

  it("produces 30 daily and 8 weekly trend points", () => {
    const r = buildPerformanceReport(drafts, now);
    expect(r.trends.daily_views).toHaveLength(30);
    expect(r.trends.weekly_engagement).toHaveLength(8);
  });

  it("returns top_performing sorted descending by views", () => {
    const r = buildPerformanceReport(drafts, now);
    const views = r.top_performing.map((m) => m.views);
    expect([...views].sort((a, b) => b - a)).toEqual(views);
  });

  it("groups by_type with counts", () => {
    const r = buildPerformanceReport(drafts, now);
    expect(r.by_type["article"]!.count).toBe(1);
    expect(r.by_type["sns-x"]!.count).toBe(1);
  });

  it("is fully reproducible for the same inputs", () => {
    expect(buildPerformanceReport(drafts, now)).toEqual(buildPerformanceReport(drafts, now));
  });

  it("handles the empty case", () => {
    const r = buildPerformanceReport([], now);
    expect(r.overview.total_published).toBe(0);
    expect(r.overview.avg_seo_score).toBe(0);
  });
});
