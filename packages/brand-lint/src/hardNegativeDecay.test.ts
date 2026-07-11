import { describe, it, expect } from "vitest";
import {
  DECAY_HALF_LIFE_DAYS,
  HARD_CUTOFF_DAYS,
  decayWeight,
  isStillRelevant,
  daysSince,
  weightSamples,
  selectRelevantSamples,
  weightedCount,
  type HardNegativeSample,
} from "./hardNegativeDecay.js";

const NOW_MS = Date.parse("2026-05-01T00:00:00Z");
const ONE_DAY_MS = 1000 * 60 * 60 * 24;

function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * ONE_DAY_MS).toISOString();
}

describe("decayWeight", () => {
  it("returns 1.0 for fresh hard negatives", () => {
    expect(decayWeight(0)).toBe(1);
  });

  it("returns 0.5 at the half-life", () => {
    expect(decayWeight(DECAY_HALF_LIFE_DAYS)).toBeCloseTo(0.5, 5);
  });

  it("monotonically decreases as age grows", () => {
    let prev = decayWeight(0);
    for (const d of [10, 30, 60, 90, 120, 170]) {
      const w = decayWeight(d);
      expect(w).toBeLessThan(prev);
      prev = w;
    }
  });

  it("returns 0 at or beyond the hard cutoff", () => {
    expect(decayWeight(HARD_CUTOFF_DAYS)).toBe(0);
    expect(decayWeight(HARD_CUTOFF_DAYS + 30)).toBe(0);
    expect(decayWeight(5 * 365)).toBe(0);
  });

  it("clamps negative ages to 1.0 and rejects NaN/Infinity", () => {
    expect(decayWeight(-5)).toBe(1);
    expect(decayWeight(Infinity)).toBe(0);
    expect(decayWeight(NaN)).toBe(0);
  });
});

describe("isStillRelevant", () => {
  it("treats fresh + recent samples as relevant", () => {
    expect(isStillRelevant(0)).toBe(true);
    expect(isStillRelevant(30)).toBe(true);
  });

  it("excludes ancient samples below default threshold", () => {
    expect(isStillRelevant(120)).toBe(false);
    expect(isStillRelevant(5 * 365)).toBe(false);
  });

  it("custom threshold tunes inclusion", () => {
    expect(isStillRelevant(60, 0.3)).toBe(false);
    expect(isStillRelevant(60, 0.2)).toBe(true);
  });
});

describe("daysSince", () => {
  it("returns approximately 30 for an ISO timestamp 30 days ago", () => {
    expect(daysSince(isoDaysAgo(30), NOW_MS)).toBeCloseTo(30, 5);
  });

  it("never returns negative for future timestamps", () => {
    const future = new Date(NOW_MS + 5 * ONE_DAY_MS).toISOString();
    expect(daysSince(future, NOW_MS)).toBe(0);
  });

  it("returns Infinity for unparseable strings", () => {
    expect(daysSince("not-a-date", NOW_MS)).toBe(Infinity);
  });
});

describe("weightSamples / weightedCount", () => {
  const samples: HardNegativeSample[] = [
    { id: "fresh", created_at: isoDaysAgo(0) },
    { id: "month", created_at: isoDaysAgo(30) },
    { id: "quarter", created_at: isoDaysAgo(90) },
    { id: "ancient", created_at: isoDaysAgo(5 * 365) },
  ];

  it("annotates each sample with daysOld and weight", () => {
    const weighted = weightSamples(samples, NOW_MS);
    expect(weighted).toHaveLength(4);
    expect(weighted[0]!.weight).toBe(1);
    expect(weighted[1]!.weight).toBeCloseTo(0.5, 5);
    expect(weighted[2]!.weight).toBeCloseTo(0.125, 5);
    expect(weighted[3]!.weight).toBe(0);
  });

  it("weightedCount sums decayed weights (ancient ≈ 0 contribution)", () => {
    const total = weightedCount(samples, NOW_MS);
    expect(total).toBeGreaterThan(1.6);
    expect(total).toBeLessThan(1.7);
  });
});

describe("selectRelevantSamples — boundary shift evaluation", () => {
  it("excludes 5-year-old NG, keeps recent rejections", () => {
    const pre = { id: "legacy", created_at: isoDaysAgo(5 * 365) };
    const post1 = { id: "recent_a", created_at: isoDaysAgo(7) };
    const post2 = { id: "recent_b", created_at: isoDaysAgo(30) };
    const selected = selectRelevantSamples([pre, post1, post2], { now: NOW_MS });
    expect(selected.map((s) => s.id)).toEqual(["recent_a", "recent_b"]);
  });

  it("respects topK: 30 mixed samples → top 5 by weight (newest first)", () => {
    const samples: HardNegativeSample[] = [];
    for (let i = 0; i < 15; i++) samples.push({ id: `young_${i}`, created_at: isoDaysAgo(i) });
    for (let i = 0; i < 15; i++) samples.push({ id: `old_${i}`, created_at: isoDaysAgo(150 + i) });
    const selected = selectRelevantSamples(samples, { now: NOW_MS, topK: 5 });
    expect(selected).toHaveLength(5);
    for (const s of selected) expect(s.id.startsWith("young_")).toBe(true);
  });

  it("threshold tuning: lowering threshold widens the kept window", () => {
    const samples: HardNegativeSample[] = [
      { id: "60d", created_at: isoDaysAgo(60) },
      { id: "120d", created_at: isoDaysAgo(120) },
    ];
    expect(selectRelevantSamples(samples, { now: NOW_MS, threshold: 0.3 }).map((s) => s.id)).toEqual([]);
    expect(selectRelevantSamples(samples, { now: NOW_MS, threshold: 0.05 }).map((s) => s.id)).toEqual(["60d", "120d"]);
  });
});
