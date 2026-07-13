/**
 * Adapted from 実運用SaaS `tests/whatif-mape-tracker.test.ts` and the
 * drift logic in `server/jobs/mape-drift-check.ts` — Supabase plumbing
 * replaced by direct arrays; golden numbers unchanged (recent 1100 vs
 * baseline 1000 → MAPE 0.0909; 30% average threshold for drift).
 */
import { describe, it, expect } from 'vitest';
import {
  computeMape,
  computeBaselineMape,
  detectMapeDrift,
  DEFAULT_MAPE_DRIFT_THRESHOLD,
} from './mape.js';

describe('computeMape', () => {
  it('computes the absolute percentage error', () => {
    expect(computeMape(1100, 1000)).toBeCloseTo(0.0909, 3);
    expect(computeMape(100, 130)).toBeCloseTo(0.3, 6);
  });

  it('returns null when actual is 0 (APE undefined)', () => {
    expect(computeMape(0, 100)).toBeNull();
  });
});

describe('computeBaselineMape', () => {
  it('uses the baseline mean as the naive prediction (golden: 1100 vs 1000)', () => {
    const record = computeBaselineMape([1100], [1000, 1000]);
    expect(record).not.toBeNull();
    expect(record!.actualValue).toBeCloseTo(1100, 0);
    expect(record!.predictedValue).toBeCloseTo(1000, 0);
    expect(record!.mape).toBeCloseTo(0.0909, 3);
  });

  it('averages multi-observation windows before comparing', () => {
    // recent mean = 22, baseline mean = 20 → mape = 2/22 = 0.0909
    const record = computeBaselineMape([20, 24], [18, 22]);
    expect(record!.actualValue).toBeCloseTo(22, 4);
    expect(record!.predictedValue).toBeCloseTo(20, 4);
    expect(record!.mape).toBeCloseTo(0.0909, 3);
  });

  it('returns null on empty windows or zero recent mean', () => {
    expect(computeBaselineMape([], [1, 2])).toBeNull();
    expect(computeBaselineMape([1, 2], [])).toBeNull();
    expect(computeBaselineMape([0], [10])).toBeNull();
  });
});

describe('detectMapeDrift', () => {
  it('flags groups whose average MAPE exceeds 30%', () => {
    const drifted = detectMapeDrift([
      { groupId: 't1', mape: 0.4 },
      { groupId: 't1', mape: 0.35 },
      { groupId: 't2', mape: 0.1 },
    ]);
    expect(drifted).toHaveLength(1);
    expect(drifted[0]!.groupId).toBe('t1');
    expect(drifted[0]!.avgMape).toBeCloseTo(0.375, 6);
    expect(drifted[0]!.sampleCount).toBe(2);
  });

  it('does not flag a group exactly at the threshold (strict >)', () => {
    const drifted = detectMapeDrift([{ groupId: 't1', mape: DEFAULT_MAPE_DRIFT_THRESHOLD }]);
    expect(drifted).toEqual([]);
  });

  it('honours a custom threshold', () => {
    const drifted = detectMapeDrift([{ groupId: 't1', mape: 0.2 }], 0.1);
    expect(drifted).toHaveLength(1);
  });
});
