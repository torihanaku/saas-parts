/**
 * Tests for the power-analysis test designer (origin:
 * dev-dashboard-v2 `server/services/incrementalityDesignAgent.ts`; the
 * original test exercised it through the Hono route — asserted values here
 * are the same computation invoked directly).
 */
import { describe, it, expect } from 'vitest';
import { designTest } from './design-test.js';

describe('designTest', () => {
  it('computes the classic two-proportion sample size (baseline 5%, lift 10%)', () => {
    const result = designTest({
      metric: 'conversion',
      baseline: 0.05,
      expectedLift: 0.10,
    });

    // n = (1.96 + 0.84)² · [p1(1−p1) + p2(1−p2)] / (p1 − p2)²
    //   = 7.84 · (0.0475 + 0.051975) / 0.000025 = 31195.36 → ceil = 31196
    expect(result.sampleSizePerGroup).toBe(31196);
    expect(result.totalSampleSize).toBe(62392);
    // duration = ceil(2n / dailyTraffic=1000) = ceil(62.392) = 63
    expect(result.suggestedDurationDays).toBe(63);
    expect(result.splitRatio).toEqual([0.5, 0.5]);
    expect(result.warnings).toEqual([]);
  });

  it('requires larger samples for smaller lifts', () => {
    const small = designTest({ metric: 'conversion', baseline: 0.05, expectedLift: 0.05 });
    const large = designTest({ metric: 'conversion', baseline: 0.05, expectedLift: 0.20 });
    expect(small.sampleSizePerGroup).toBeGreaterThan(large.sampleSizePerGroup);
    expect(small.sampleSizePerGroup).toBeGreaterThan(0);
  });

  it('warns when requested power exceeds 0.95', () => {
    const result = designTest({
      metric: 'conversion',
      baseline: 0.02,
      expectedLift: 0.10,
      power: 0.99,
    });
    expect(result.warnings).toContain(
      'High power ( > 0.95) requires significantly larger sample sizes.',
    );
  });

  it('scales suggested duration with daily traffic', () => {
    const slow = designTest({ metric: 'conversion', baseline: 0.05, expectedLift: 0.10, dailyTraffic: 500 });
    const fast = designTest({ metric: 'conversion', baseline: 0.05, expectedLift: 0.10, dailyTraffic: 10000 });
    expect(slow.suggestedDurationDays).toBeGreaterThan(fast.suggestedDurationDays);
  });
});
