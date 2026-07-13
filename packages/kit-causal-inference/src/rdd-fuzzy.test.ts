/**
 * Ported from 実運用SaaS `tests/server/lib/causal/rdd/fuzzy.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { runFuzzyRdd } from './rdd-fuzzy.js';

/**
 * Reproducible LCG so synthetic data is identical across machines.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('runFuzzyRdd: known synthetic dataset', () => {
  it('recovers a true LATE of 4 within 25% tolerance', async () => {
    // Setup: x ∈ [-5, 5]; treatment-take-up D jumps from ~20% to ~80% at x=0;
    // outcome y = 1 + 0.5x + 4·D + noise. True LATE = 4.
    const rng = makeRng(2025);
    const observations: Array<{ x: number; y: number; d: number }> = [];
    for (let i = -50; i <= 50; i++) {
      if (i === 0) continue;
      const x = i / 10;
      // Take-up probability jumps at the cutoff but stays imperfect on each side
      const p = x >= 0 ? 0.8 : 0.2;
      const d = rng() < p ? 1 : 0;
      const y = 1 + 0.5 * x + 4 * d + (rng() - 0.5) * 0.4;
      observations.push({ x, y, d });
    }

    const result = await runFuzzyRdd({
      observations,
      cutoff: 0,
      bandwidth: 1.5,
      confidenceLevel: 0.95,
    });

    expect(result.method).toBe('fuzzy_rdd_2sls');
    expect(result.effect).not.toBeNull();
    const effect = result.effect as number;
    // True effect 4; allow generous tolerance because the synthetic noise is
    // amplified by division on first-stage (~0.6 jump) → ~17% noise floor.
    expect(effect).toBeGreaterThan(3.0);
    expect(effect).toBeLessThan(5.0);
    expect(result.complianceRate).not.toBeNull();
    expect(result.complianceRate as number).toBeGreaterThan(0.4);
    expect(result.reducedFormJump).not.toBeNull();
    expect(result.seEstimate).not.toBeNull();
    expect(result.ciLow).toBeLessThan(effect);
    expect(result.ciHigh).toBeGreaterThan(effect);
  });

  it('derives a Silverman bandwidth when none is provided', async () => {
    const rng = makeRng(7);
    const observations: Array<{ x: number; y: number; d: number }> = [];
    for (let i = -50; i <= 50; i++) {
      if (i === 0) continue;
      const x = i / 10;
      const d = rng() < (x >= 0 ? 0.7 : 0.1) ? 1 : 0;
      observations.push({ x, y: 0.3 * x + 2 * d, d });
    }
    const result = await runFuzzyRdd({ observations, cutoff: 0 });
    expect(result.bandwidthMethod).toBe('silverman');
    expect(result.bandwidth).toBeGreaterThan(0);
  });

  it('flags weak first stage when treatment barely shifts at cutoff', async () => {
    // Construct a deterministic dataset with NO jump in d at the cutoff:
    // d follows a smooth 0.5 + 0.01·x trend that does not jump. The fitted
    // first-stage local-linear should produce a near-zero discontinuity.
    const observations: Array<{ x: number; y: number; d: number }> = [];
    for (let i = -50; i <= 50; i++) {
      if (i === 0) continue;
      const x = i / 10;
      const d = 0.5 + 0.01 * x; // continuous, no jump → first-stage ≈ 0
      observations.push({ x, y: 0.5 * x + 4 * d, d });
    }
    const result = await runFuzzyRdd({ observations, cutoff: 0, bandwidth: 1.5 });
    expect(result.warnings).toContain('weak_first_stage');
    expect(result.effect).toBeNull();
    expect(result.complianceRate).not.toBeNull();
    expect(result.reducedFormJump).not.toBeNull();
  });

  it('returns null effect with warning when too few obs per side', async () => {
    const observations = [
      { x: -0.1, y: 1, d: 0 },
      { x: -0.05, y: 1.1, d: 0 },
      { x: 0.05, y: 4, d: 1 },
      { x: 0.1, y: 4.1, d: 1 },
    ];
    const result = await runFuzzyRdd({ observations, cutoff: 0, bandwidth: 1 });
    expect(result.effect).toBeNull();
    expect(result.warnings).toContain('sample_size_small_per_side');
  });

  it('falls back to z=1.96 on unsupported confidence level', async () => {
    const rng = makeRng(33);
    const observations: Array<{ x: number; y: number; d: number }> = [];
    for (let i = -30; i <= 30; i++) {
      if (i === 0) continue;
      const x = i / 10;
      const d = rng() < (x >= 0 ? 0.8 : 0.2) ? 1 : 0;
      observations.push({ x, y: 0.5 * x + 3 * d, d });
    }
    const result = await runFuzzyRdd({
      observations,
      cutoff: 0,
      bandwidth: 1.5,
      confidenceLevel: 0.42,
    });
    expect(result.warnings).toContain('invalid_confidence_level');
    expect(result.effect).not.toBeNull();
  });

  it('warns when treatment take-up is degenerate (all 0 or all 1)', async () => {
    // all d = 1 — first-stage jump = 0 → weak_first_stage AND
    // treatment_take_up_degenerate.
    const observations: Array<{ x: number; y: number; d: number }> = [];
    for (let i = -20; i <= 20; i++) {
      if (i === 0) continue;
      observations.push({ x: i / 10, y: 0.5 * (i / 10) + 2, d: 1 });
    }
    const result = await runFuzzyRdd({ observations, cutoff: 0, bandwidth: 1 });
    // weak_first_stage triggers first; degenerate warning may not appear if
    // we returned early, so check at least one of the two.
    const ws = result.warnings;
    expect(ws.includes('weak_first_stage') || ws.includes('treatment_take_up_degenerate')).toBe(true);
  });
});

describe('runFuzzyRdd: input validation', () => {
  it('throws on empty observations', async () => {
    await expect(runFuzzyRdd({ observations: [], cutoff: 0 })).rejects.toThrow(/non-empty/);
  });

  it('throws on non-finite cutoff', async () => {
    await expect(
      runFuzzyRdd({ observations: [{ x: 1, y: 1, d: 1 }], cutoff: Number.NaN }),
    ).rejects.toThrow(/finite/);
  });

  it('throws on bandwidth <= 0', async () => {
    await expect(
      runFuzzyRdd({
        observations: [{ x: 1, y: 1, d: 1 }],
        cutoff: 0,
        bandwidth: -1,
      }),
    ).rejects.toThrow(/bandwidth must be > 0/);
  });

  it('throws on non-finite obs values', async () => {
    await expect(
      runFuzzyRdd({
        observations: [{ x: Number.NaN, y: 1, d: 1 }],
        cutoff: 0,
        bandwidth: 1,
      }),
    ).rejects.toThrow(/finite x, y, d/);
  });

  it('throws when no observations on one side of cutoff (within bandwidth)', async () => {
    await expect(
      runFuzzyRdd({
        observations: [
          { x: 1, y: 1, d: 1 },
          { x: 2, y: 2, d: 1 },
        ],
        cutoff: 0,
        bandwidth: 5,
      }),
    ).rejects.toThrow(/no observations within bandwidth on left/);
  });

  it('throws when bandwidth cannot be derived (zero variance in x)', async () => {
    await expect(
      runFuzzyRdd({
        observations: [
          { x: 5, y: 1, d: 1 },
          { x: 5, y: 2, d: 0 },
          { x: 5, y: 3, d: 1 },
        ],
        cutoff: 5,
      }),
    ).rejects.toThrow(/zero variance in x/);
  });
});
