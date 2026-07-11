import { describe, it, expect } from "vitest";
import { aggregateDailyMetrics, getChallengerMetrics } from "./metrics-aggregator.js";
import { InMemoryChallengerStore } from "./stores.js";

describe("aggregateDailyMetrics", () => {
  it("upserts and returns computed daily metrics", async () => {
    const store = new InMemoryChallengerStore();
    store.countMetrics = async () => ({
      proposed: 5,
      accepted: 2,
      hardNegatives: 3,
      lintPassed: 4,
      approved: 3,
    });

    const result = await aggregateDailyMetrics("t1", store, "2026-05-01");
    expect(result.challengerProposed).toBe(5);
    expect(result.challengerAccepted).toBe(2);
    expect(result.hardNegativeAdded).toBe(3);
    expect(result.lintAccuracy).toBeCloseTo(0.75, 5);

    // Persisted for later query.
    const summary = await getChallengerMetrics("t1", store, 30);
    expect(summary.days).toHaveLength(1);
    expect(summary.days[0]!.metricDate).toBe("2026-05-01");
  });

  it("lintAccuracy is null when nothing passed lint", async () => {
    const store = new InMemoryChallengerStore();
    store.countMetrics = async () => ({ proposed: 0, accepted: 0, hardNegatives: 0, lintPassed: 0, approved: 0 });
    const result = await aggregateDailyMetrics("t1", store, "2026-05-01");
    expect(result.lintAccuracy).toBeNull();
  });
});

describe("getChallengerMetrics", () => {
  it("computes day1 vs day30 deltas", async () => {
    const store = new InMemoryChallengerStore();
    await store.upsertDailyMetrics({
      tenant_id: "t1", metric_date: "2026-04-01",
      challenger_proposed: 10, challenger_accepted: 2, hard_negative_added: 1, lint_accuracy: 0.5,
    });
    await store.upsertDailyMetrics({
      tenant_id: "t1", metric_date: "2026-04-30",
      challenger_proposed: 10, challenger_accepted: 8, hard_negative_added: 4, lint_accuracy: 0.9,
    });

    const summary = await getChallengerMetrics("t1", store, 30);
    expect(summary.days).toHaveLength(2);
    expect(summary.day1vsDay30.challengerAcceptanceRate.day1).toBeCloseTo(0.2, 5);
    expect(summary.day1vsDay30.challengerAcceptanceRate.day30).toBeCloseTo(0.8, 5);
    expect(summary.day1vsDay30.challengerAcceptanceRate.delta).toBeCloseTo(0.6, 5);
    expect(summary.day1vsDay30.lintAccuracy.delta).toBeCloseTo(0.4, 5);
  });

  it("returns zeroed comparison when there is no data", async () => {
    const store = new InMemoryChallengerStore();
    const summary = await getChallengerMetrics("empty", store, 30);
    expect(summary.days).toHaveLength(0);
    expect(summary.day1vsDay30.challengerAcceptanceRate.day1).toBe(0);
    expect(summary.day1vsDay30.lintAccuracy.delta).toBeNull();
  });
});
