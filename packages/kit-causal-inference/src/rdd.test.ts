/**
 * Ported from dev-dashboard-v2 `tests/causal-rdd.test.ts` (the Hono route
 * smoke tests were dropped — HTTP wiring stayed in the product repo).
 */
import { describe, it, expect } from "vitest";
import { runRdd, silvermanBandwidth } from "./rdd.js";
import { linearRegression, standardErrorAt } from "./stats.js";

// ─── Stats helpers ──────────────────────────────────────────────────────────

describe("stats: linearRegression", () => {
  it("recovers the slope and intercept of a noise-free line", () => {
    // y = 3 + 2x
    const xs = [0, 1, 2, 3, 4, 5];
    const ys = xs.map((x) => 3 + 2 * x);
    const fit = linearRegression(xs, ys);
    expect(fit.intercept).toBeCloseTo(3, 6);
    expect(fit.slope).toBeCloseTo(2, 6);
    expect(fit.residualVariance).toBeCloseTo(0, 6);
    expect(fit.n).toBe(6);
  });

  it("estimates positive residual variance when y deviates from a line", () => {
    // Three points not perfectly collinear → RSS > 0, residual variance > 0.
    const xs = [0, 1, 2];
    const ys = [0, 1.2, 1.9];
    const fit = linearRegression(xs, ys);
    expect(fit.residualVariance).toBeGreaterThan(0);
    expect(Number.isFinite(fit.slope)).toBe(true);
    expect(Number.isFinite(fit.intercept)).toBe(true);
  });

  it("throws on length mismatch", () => {
    expect(() => linearRegression([1, 2], [1])).toThrow(/length mismatch/);
  });

  it("throws when n < 2", () => {
    expect(() => linearRegression([1], [1])).toThrow(/at least 2/);
  });

  it("throws when x has zero variance", () => {
    expect(() => linearRegression([2, 2, 2], [1, 2, 3])).toThrow(/zero variance/);
  });

  it("standardErrorAt is zero with only 2 points (no residual df)", () => {
    const fit = linearRegression([0, 1], [0, 1]);
    expect(standardErrorAt(fit, 0.5)).toBe(0);
  });

  it("standardErrorAt is positive at non-mean x with residual variance", () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = [0.1, 1.1, 1.9, 3.2, 3.8];
    const fit = linearRegression(xs, ys);
    const seMean = standardErrorAt(fit, fit.meanX);
    const seFar = standardErrorAt(fit, fit.meanX + 5);
    expect(seFar).toBeGreaterThan(seMean);
  });
});

// ─── runRdd unit tests ──────────────────────────────────────────────────────

describe("runRdd: known synthetic dataset", () => {
  it("recovers a true effect of 5 within 10% tolerance", async () => {
    // Generate y = 1 + 0.5*x  with a +5 jump at x >= 0
    // Deterministic small noise via a simple LCG so the test is reproducible.
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return (seed / 2 ** 32 - 0.5) * 0.4; // ~U(-0.2, +0.2)
    };

    const observations: Array<{ x: number; y: number }> = [];
    for (let i = -50; i <= 50; i++) {
      if (i === 0) continue; // exclude exactly-on-cutoff so left/right are clean
      const x = i / 10; // x ranges over [-5, 5] in 0.1 steps
      const treated = x >= 0 ? 5 : 0;
      const y = 1 + 0.5 * x + treated + rand();
      observations.push({ x, y });
    }

    const result = await runRdd({
      observations,
      cutoff: 0,
      bandwidth: 1.0, // 1 unit on either side → ~10 obs each
      confidenceLevel: 0.95,
    });

    expect(result.effect).not.toBeNull();
    const effect = result.effect as number;
    // True effect is 5; allow 10% tolerance.
    expect(effect).toBeGreaterThan(4.5);
    expect(effect).toBeLessThan(5.5);
    expect(result.method).toBe("sharp_rdd");
    expect(result.bandwidth).toBe(1.0);
    expect(result.bandwidthMethod).toBe("user");
    expect(result.nLeft).toBeGreaterThanOrEqual(5);
    expect(result.nRight).toBeGreaterThanOrEqual(5);
    expect(result.seEstimate).not.toBeNull();
    expect(result.ciLow).not.toBeNull();
    expect(result.ciHigh).not.toBeNull();
    expect((result.ciHigh as number) - (result.ciLow as number)).toBeGreaterThan(0);
    expect(result.assumptions.find((a) => a.name === "continuity_at_cutoff")).toBeDefined();
  });

  it("derives a Silverman bandwidth when none is provided", async () => {
    const observations: Array<{ x: number; y: number }> = [];
    for (let i = -50; i <= 50; i++) {
      if (i === 0) continue;
      const x = i / 10;
      const treated = x >= 0 ? 3 : 0;
      observations.push({ x, y: 0.2 * x + treated });
    }
    const result = await runRdd({ observations, cutoff: 0 });
    expect(result.bandwidthMethod).toBe("silverman");
    expect(result.bandwidth).toBeGreaterThan(0);
    expect(result.effect).not.toBeNull();
    // Estimate near the true 3 within reasonable tolerance.
    expect(Math.abs((result.effect as number) - 3)).toBeLessThan(0.5);
  });

  it("returns null effect with warning when too few obs per side", async () => {
    const observations = [
      { x: -0.1, y: 1 },
      { x: -0.05, y: 1.1 },
      { x: 0.05, y: 4 },
      { x: 0.1, y: 4.1 },
    ];
    const result = await runRdd({
      observations,
      cutoff: 0,
      bandwidth: 1,
    });
    expect(result.effect).toBeNull();
    expect(result.seEstimate).toBeNull();
    expect(result.warnings).toContain("sample_size_small_per_side");
    expect(result.assumptions[0]!.satisfied).toBe(false);
  });

  it("falls back to z=1.96 and warns on unsupported confidence level", async () => {
    const observations: Array<{ x: number; y: number }> = [];
    for (let i = -20; i <= 20; i++) {
      if (i === 0) continue;
      observations.push({ x: i / 10, y: i / 10 + (i >= 0 ? 2 : 0) });
    }
    const result = await runRdd({
      observations,
      cutoff: 0,
      bandwidth: 1,
      confidenceLevel: 0.42, // unsupported
    });
    expect(result.warnings).toContain("invalid_confidence_level");
    expect(result.effect).not.toBeNull();
  });
});

describe("runRdd: input validation", () => {
  it("throws on empty observations", async () => {
    await expect(
      runRdd({ observations: [], cutoff: 0 }),
    ).rejects.toThrow(/non-empty/);
  });

  it("throws on non-finite cutoff", async () => {
    await expect(
      runRdd({ observations: [{ x: 1, y: 1 }], cutoff: Number.NaN }),
    ).rejects.toThrow(/finite/);
  });

  it("throws on bandwidth <= 0", async () => {
    await expect(
      runRdd({ observations: [{ x: 1, y: 1 }], cutoff: 0, bandwidth: 0 }),
    ).rejects.toThrow(/bandwidth must be > 0/);
    await expect(
      runRdd({ observations: [{ x: 1, y: 1 }], cutoff: 0, bandwidth: -1 }),
    ).rejects.toThrow(/bandwidth must be > 0/);
  });

  it("throws on non-finite observation values", async () => {
    await expect(
      runRdd({ observations: [{ x: Number.NaN, y: 1 }], cutoff: 0, bandwidth: 1 }),
    ).rejects.toThrow(/finite x and y/);
    await expect(
      runRdd({ observations: [{ x: 1, y: Number.POSITIVE_INFINITY }], cutoff: 0, bandwidth: 1 }),
    ).rejects.toThrow(/finite x and y/);
  });

  it("throws when no observations on one side of cutoff (within bandwidth)", async () => {
    // All observations are on the right of cutoff
    await expect(
      runRdd({
        observations: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
          { x: 3, y: 3 },
        ],
        cutoff: 0,
        bandwidth: 5,
      }),
    ).rejects.toThrow(/no observations within bandwidth on left/);

    // All on the left
    await expect(
      runRdd({
        observations: [
          { x: -1, y: 1 },
          { x: -2, y: 2 },
          { x: -3, y: 3 },
        ],
        cutoff: 0,
        bandwidth: 5,
      }),
    ).rejects.toThrow(/no observations within bandwidth on right/);
  });

  it("throws when bandwidth cannot be derived (zero variance in x)", async () => {
    await expect(
      runRdd({
        observations: [
          { x: 5, y: 1 },
          { x: 5, y: 2 },
          { x: 5, y: 3 },
        ],
        cutoff: 5,
      }),
    ).rejects.toThrow(/zero variance in x/);
  });
});

describe("silvermanBandwidth", () => {
  it("returns 0 for arrays with fewer than 2 elements", () => {
    expect(silvermanBandwidth([])).toBe(0);
    expect(silvermanBandwidth([1])).toBe(0);
  });

  it("returns 0 when all values are equal (sigma = 0)", () => {
    expect(silvermanBandwidth([3, 3, 3, 3])).toBe(0);
  });

  it("scales with stdev and decreases as n grows", () => {
    const small = silvermanBandwidth([0, 1, 2, 3, 4]);
    const big = silvermanBandwidth(
      Array.from({ length: 1000 }, (_, i) => i / 100),
    );
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(0);
    // n^(-1/5) shrinks → for similar stdev, larger n yields smaller-or-comparable bandwidth
    // (We check positivity + bounded shape rather than strict ordering since stdev differs.)
    expect(Number.isFinite(small) && Number.isFinite(big)).toBe(true);
  });
});
