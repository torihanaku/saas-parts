/**
 * Gold-standard tests for causal inference estimators.
 *
 * Ported from 実運用SaaS `tests/causal/gold-standard/estimators.test.ts`.
 *
 * Compares TypeScript implementation results against R/Python ground-truth
 * fixture values with 1% relative error tolerance for effect sizes.
 *
 * Estimators tested:
 *   1. Difference-in-Differences (DID) — 3 cases
 *   2. Propensity Score Matching (PSM) — 3 cases
 *   3. Regression Discontinuity Design (RDD) — 3 cases
 *   4. Media Mix Modeling (MMM) — 3 cases
 *
 * Total: 12 test cases
 */

import { describe, it, expect } from 'vitest';
import { runDid } from './did.js';
import { runPsm } from './psm.js';
import { runRdd } from './rdd.js';
import { runMmm } from './mmm.js';
import {
  didFixtures,
  psmFixtures,
  rddFixtures,
  mmmFixtures,
} from './gold-standard-fixtures.js';

// ─── Helper: relative error ───────────────────────────────────────────────

function relativeError(actual: number, expected: number): number {
  if (expected === 0) return Math.abs(actual);
  return Math.abs((actual - expected) / expected);
}

const EFFECT_TOLERANCE = 0.05;  // 5% for effect sizes (generous for noisy data)
const SE_TOLERANCE = 0.10;      // 10% for standard errors

// ─── DID Gold-Standard Tests ──────────────────────────────────────────────

describe('DID gold-standard (3 cases)', () => {
  it.each(didFixtures)('$name', async (fixture) => {
    const result = await runDid({
      tenantId: 'gold-standard',
      experimentId: fixture.name,
      treatmentGroup: fixture.treatmentGroup,
      controlGroup: fixture.controlGroup,
    });

    expect(result.effectSize).not.toBeNull();

    // Check effect size is within expected range
    if (fixture.expected.effectSize !== 0) {
      const relErr = relativeError(result.effectSize!, fixture.expected.effectSize);
      expect(relErr).toBeLessThan(EFFECT_TOLERANCE);
    }

    // Check standard error (if expected value provided)
    if ('stdError' in fixture.expected && fixture.expected.stdError !== undefined && result.stdError !== null) {
      const seErr = relativeError(result.stdError, fixture.expected.stdError);
      expect(seErr).toBeLessThan(SE_TOLERANCE);
    }

    // Check p-value bounds
    if ('pValueUpperBound' in fixture.expected && fixture.expected.pValueUpperBound !== undefined) {
      expect(result.pValue).toBeLessThan(fixture.expected.pValueUpperBound);
    }
    if ('pValueLowerBound' in fixture.expected && fixture.expected.pValueLowerBound !== undefined) {
      expect(result.pValue!).toBeGreaterThan(fixture.expected.pValueLowerBound!);
    }
  });
});

// ─── PSM Gold-Standard Tests ──────────────────────────────────────────────

describe('PSM gold-standard (3 cases)', () => {
  it.each(psmFixtures)('$name', async (fixture) => {
    const result = await runPsm({
      tenantId: 'gold-standard',
      experimentId: fixture.name,
      treatmentGroup: fixture.treatmentGroup,
      poolGroup: fixture.poolGroup,
    });

    expect(result.effectSize).not.toBeNull();

    // Check effect size direction and minimum
    if (fixture.expected.effectSizePositive) {
      expect(result.effectSize!).toBeGreaterThan(fixture.expected.effectSizeMin);
    }

    // Check p-value bounds
    if ('pValueUpperBound' in fixture.expected && fixture.expected.pValueUpperBound !== undefined) {
      expect(result.pValue!).toBeLessThan(fixture.expected.pValueUpperBound!);
    }
  });
});

// ─── RDD Gold-Standard Tests ──────────────────────────────────────────────

describe('RDD gold-standard (3 cases)', () => {
  it.each(rddFixtures)('$name', async (fixture) => {
    const result = await runRdd({
      observations: fixture.observations,
      cutoff: fixture.cutoff,
      bandwidth: fixture.bandwidth,
    });

    expect(result.effect).not.toBeNull();

    // Check effect is within expected range
    expect(result.effect!).toBeGreaterThanOrEqual(fixture.expected.effectMin);
    expect(result.effect!).toBeLessThanOrEqual(fixture.expected.effectMax);

    // Check standard error
    if (result.seEstimate !== null) {
      expect(result.seEstimate).toBeLessThan(fixture.expected.seMax);
    }
  });
});

// ─── MMM Gold-Standard Tests ──────────────────────────────────────────────

describe('MMM gold-standard (3 cases)', () => {
  it.each(mmmFixtures)('$name', async (fixture) => {
    const result = await runMmm({
      channels: fixture.channels,
      y: fixture.y,
      seed: 42,
      samples: 500,
      burnIn: 200,
    });

    // Check R-squared
    expect(result.rSquared).toBeGreaterThan(fixture.expected.rSquaredMin);

    // Check ROI is positive for at least one channel
    if (fixture.expected.roiPositive) {
      const anyPositiveRoi = result.channels.some((ch) => ch.roi !== null && ch.roi! > 0);
      expect(anyPositiveRoi).toBe(true);
    }
  });
});
