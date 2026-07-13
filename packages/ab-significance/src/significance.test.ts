/**
 * Ported from 実運用SaaS `tests/ab-testing/significance.test.ts`
 * plus golden numeric fixtures (fixed posteriors → expected quantiles
 * within tolerance).
 *
 * Verifies:
 *   - betaQuantile bounds (0/1 edge cases, mean ≈ alpha/(alpha+beta))
 *   - betaCredibleInterval has lower < mean < upper for sane params
 *   - decideSignificance: insufficient samples → status="insufficient_samples"
 *   - decideSignificance: clear winner → status="winner" + correct id
 *   - decideSignificance: overlapping CIs → status="still_running"
 *   - probit symmetry: probit(0.5) ≈ 0
 */

import { describe, it, expect } from "vitest";
import {
  decideSignificance,
  betaQuantile,
  betaCredibleInterval,
  __testing,
} from "./index";

describe("probit", () => {
  it("returns ~0 at p=0.5", () => {
    expect(Math.abs(__testing.probit(0.5))).toBeLessThan(1e-6);
  });

  it("is monotonic", () => {
    const a = __testing.probit(0.1);
    const b = __testing.probit(0.5);
    const c = __testing.probit(0.9);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("clamps p<=0 to -Infinity and p>=1 to +Infinity", () => {
    expect(__testing.probit(0)).toBe(-Infinity);
    expect(__testing.probit(1)).toBe(Infinity);
  });

  it("golden: matches known standard-normal quantiles", () => {
    expect(__testing.probit(0.975)).toBeCloseTo(1.959964, 5);
    expect(__testing.probit(0.025)).toBeCloseTo(-1.959964, 5);
    expect(__testing.probit(0.995)).toBeCloseTo(2.575829, 5);
  });
});

describe("betaQuantile", () => {
  it("returns 0 at p=0 and 1 at p=1", () => {
    expect(betaQuantile(2, 5, 0)).toBe(0);
    expect(betaQuantile(2, 5, 1)).toBe(1);
  });

  it("median is roughly mean for large samples", () => {
    const mean = 50 / (50 + 50);
    expect(Math.abs(betaQuantile(50, 50, 0.5) - mean)).toBeLessThan(0.05);
  });

  it("throws for non-positive params", () => {
    expect(() => betaQuantile(0, 1, 0.5)).toThrow();
    expect(() => betaQuantile(1, -1, 0.5)).toThrow();
  });

  it("golden: normal approximation of Beta(100, 200) quantiles", () => {
    // mean = 1/3, std = sqrt(100*200 / (300^2 * 301)) ≈ 0.0271713
    // q(0.025) = mean - 1.959964*std ≈ 0.280079
    // q(0.975) = mean + 1.959964*std ≈ 0.386587
    expect(betaQuantile(100, 200, 0.025)).toBeCloseTo(0.280079, 4);
    expect(betaQuantile(100, 200, 0.975)).toBeCloseTo(0.386587, 4);
  });
});

describe("betaCredibleInterval", () => {
  it("lower < mean < upper for sane params", () => {
    const { mean, lower, upper } = betaCredibleInterval(100, 200);
    expect(lower).toBeLessThan(mean);
    expect(mean).toBeLessThan(upper);
    // 95% CI for Beta(100, 200) ≈ [0.28, 0.40] roughly.
    expect(lower).toBeGreaterThan(0.25);
    expect(upper).toBeLessThan(0.42);
  });

  it("narrows as sample size grows", () => {
    const small = betaCredibleInterval(10, 10);
    const large = betaCredibleInterval(1000, 1000);
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower);
  });

  it("golden: exact values for Beta(100, 200) at 95%", () => {
    const { mean, lower, upper } = betaCredibleInterval(100, 200, 0.95);
    expect(mean).toBeCloseTo(1 / 3, 10);
    expect(lower).toBeCloseTo(0.280079, 4);
    expect(upper).toBeCloseTo(0.386587, 4);
  });
});

describe("decideSignificance", () => {
  it("returns insufficient_samples when fewer than 2 variants", () => {
    const r = decideSignificance([{ id: "a", alpha: 50, beta: 50, impressions: 200 }]);
    expect(r.status).toBe("insufficient_samples");
  });

  it("returns insufficient_samples when impressions below threshold", () => {
    const r = decideSignificance(
      [
        { id: "a", alpha: 5, beta: 5, impressions: 10 },
        { id: "b", alpha: 5, beta: 5, impressions: 10 },
      ],
      100,
    );
    expect(r.status).toBe("insufficient_samples");
    expect(r.reason).toContain("min_impressions");
  });

  it("declares winner when CI dominates all others", () => {
    // A: ~80% conversion, B: ~10%, far apart → clear winner.
    const r = decideSignificance(
      [
        { id: "a", alpha: 800, beta: 200, impressions: 1000 },
        { id: "b", alpha: 100, beta: 900, impressions: 1000 },
      ],
      100,
    );
    expect(r.status).toBe("winner");
    expect(r.winnerId).toBe("a");
    expect(r.reason).toBe("ci_dominates_all_others");
  });

  it("returns still_running when CIs overlap", () => {
    // Very close means, large variance → CIs overlap.
    const r = decideSignificance(
      [
        { id: "a", alpha: 110, beta: 100, impressions: 210 },
        { id: "b", alpha: 100, beta: 110, impressions: 210 },
      ],
      100,
    );
    expect(r.status).toBe("still_running");
    expect(r.winnerId).toBeNull();
  });

  it("intervals returned for every variant when enough samples", () => {
    const r = decideSignificance(
      [
        { id: "a", alpha: 600, beta: 400, impressions: 1000 },
        { id: "b", alpha: 400, beta: 600, impressions: 1000 },
        { id: "c", alpha: 500, beta: 500, impressions: 1000 },
      ],
      100,
    );
    expect(r.intervals).toHaveLength(3);
    for (const i of r.intervals) {
      expect(i.ciLower).toBeLessThan(i.ciUpper);
      expect(i.mean).toBeGreaterThan(0);
      expect(i.mean).toBeLessThan(1);
    }
  });
});
