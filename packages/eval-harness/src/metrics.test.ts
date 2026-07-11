import { describe, it, expect } from "vitest";
import {
  computeClassificationMetrics,
  computeConfusionMatrix,
  computeMape,
  computeOverrideRetentionRate,
  computeRepeatCatchRate,
  __test,
} from "./metrics";

describe("computeConfusionMatrix", () => {
  it("counts TP/FP/TN/FN correctly", () => {
    const m = computeConfusionMatrix([
      { expected: true, predicted: true },   // TP
      { expected: true, predicted: true },   // TP
      { expected: false, predicted: true },  // FP
      { expected: true, predicted: false },  // FN
      { expected: false, predicted: false }, // TN
    ]);
    expect(m).toEqual({ truePositive: 2, falsePositive: 1, trueNegative: 1, falseNegative: 1 });
  });
});

describe("computeClassificationMetrics", () => {
  it("returns precision/recall/f1/accuracy on a known set", () => {
    const r = computeClassificationMetrics([
      { expected: true, predicted: true },
      { expected: true, predicted: true },
      { expected: false, predicted: true },
      { expected: true, predicted: false },
      { expected: false, predicted: false },
    ]);
    expect(r.precision).toBeCloseTo(2 / 3, 5);
    expect(r.recall).toBeCloseTo(2 / 3, 5);
    expect(r.f1).toBeCloseTo(2 / 3, 5);
    expect(r.accuracy).toBeCloseTo(3 / 5, 5);
  });

  it("handles all-zero gracefully (empty input)", () => {
    const r = computeClassificationMetrics([]);
    expect(r.precision).toBe(0);
    expect(r.recall).toBe(0);
    expect(r.f1).toBe(0);
    expect(r.accuracy).toBe(0);
  });
});

describe("computeMape", () => {
  it("returns 0 for empty / mismatched lengths", () => {
    expect(computeMape([], [])).toBe(0);
    expect(computeMape([1], [1, 2])).toBe(0);
  });

  it("computes percentage error", () => {
    // predicted [110, 90], actual [100, 100] → MAPE = (10/100 + 10/100)/2 * 100 = 10
    expect(computeMape([110, 90], [100, 100])).toBeCloseTo(10, 5);
  });

  it("skips zero actuals to avoid division by zero", () => {
    expect(computeMape([5, 5], [0, 5])).toBeCloseTo(0, 5);
  });
});

describe("cosineSimilarity (private)", () => {
  it("returns 1.0 for identical vectors", () => {
    expect(__test.cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(__test.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
  it("handles empty / zero vectors gracefully", () => {
    expect(__test.cosineSimilarity([], [1, 2])).toBe(0);
    expect(__test.cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("computeRepeatCatchRate", () => {
  const baseTime = "2026-04-01T00:00:00Z";

  it("0% rate when there are no repeats", () => {
    const r = computeRepeatCatchRate([
      { embedding: [1, 0, 0], decidedAt: baseTime, autoRejected: false },
      { embedding: [0, 1, 0], decidedAt: "2026-04-02T00:00:00Z", autoRejected: false },
      { embedding: [0, 0, 1], decidedAt: "2026-04-03T00:00:00Z", autoRejected: false },
    ]);
    expect(r.repeatTotal).toBe(0);
    expect(r.rate).toBe(0);
  });

  it("counts auto-rejected repeats and divides by total repeats", () => {
    const r = computeRepeatCatchRate([
      { embedding: [1, 0, 0], decidedAt: baseTime, autoRejected: false },
      { embedding: [1, 0, 0], decidedAt: "2026-04-02T00:00:00Z", autoRejected: true }, // repeat, caught
      { embedding: [1, 0, 0], decidedAt: "2026-04-03T00:00:00Z", autoRejected: false }, // repeat, missed
    ]);
    expect(r.repeatTotal).toBe(2);
    expect(r.caught).toBe(1);
    expect(r.rate).toBeCloseTo(0.5, 5);
  });

  it("custom threshold tunes recurrence detection", () => {
    const sims = [
      { embedding: [1, 0, 0], decidedAt: baseTime, autoRejected: false },
      { embedding: [0.9, 0.43, 0], decidedAt: "2026-04-02T00:00:00Z", autoRejected: true },
    ];
    expect(computeRepeatCatchRate(sims, 0.99).repeatTotal).toBe(0);
    expect(computeRepeatCatchRate(sims, 0.85).repeatTotal).toBe(1);
  });
});

describe("computeOverrideRetentionRate", () => {
  it("returns 0 when fewer than 2 overrides", () => {
    expect(computeOverrideRetentionRate([])).toEqual({ total: 0, recurring: 0, rate: 0 });
    expect(computeOverrideRetentionRate([{ embedding: [1], decidedAt: "x" }]))
      .toEqual({ total: 1, recurring: 0, rate: 0 });
  });

  it("counts recurring overrides chronologically (overfit guardrail)", () => {
    const r = computeOverrideRetentionRate([
      { embedding: [1, 0], decidedAt: "2026-04-01T00:00:00Z" },
      { embedding: [1, 0], decidedAt: "2026-04-02T00:00:00Z" }, // recurring
      { embedding: [0, 1], decidedAt: "2026-04-03T00:00:00Z" }, // not recurring
      { embedding: [1, 0], decidedAt: "2026-04-04T00:00:00Z" }, // recurring
    ]);
    expect(r.total).toBe(4);
    expect(r.recurring).toBe(2);
    expect(r.rate).toBeCloseTo(0.5, 5);
  });

  it("ignores ordering of input (sorted internally)", () => {
    const a = computeOverrideRetentionRate([
      { embedding: [1, 0], decidedAt: "2026-04-02T00:00:00Z" },
      { embedding: [1, 0], decidedAt: "2026-04-01T00:00:00Z" },
    ]);
    expect(a.recurring).toBe(1);
  });
});
