/**
 * Adapted from dev-dashboard-v2 `tests/counterfactual-analyzer.test.ts`:
 * the Supabase mocks were replaced by direct pre/post arrays (the kit takes
 * plain arrays). Golden values: 14 pre-days at 100 and 7 post-days at 150
 * → counterfactual 100, actual 150, relative lift 0.5.
 */
import { describe, it, expect } from 'vitest';
import { estimateCounterfactual } from './counterfactual.js';

describe('estimateCounterfactual', () => {
  it('should estimate counterfactual lift correctly', () => {
    const preValues = Array(14).fill(100);
    const postValues = Array(7).fill(150);

    const result = estimateCounterfactual({ preValues, postValues });

    expect(result.counterfactual).toBe(100);
    expect(result.actual).toBe(150);
    expect(result.lift).toBeCloseTo(0.5, 4); // relative lift (150−100)/100
    expect(result.ci).toHaveLength(2);
    // Constant pre-period → stdev 0 → degenerate CI centred on absolute lift.
    expect(result.ci[0]).toBeCloseTo(50, 2);
    expect(result.ci[1]).toBeCloseTo(50, 2);
  });

  it('widens the CI when the pre-period is noisy', () => {
    // Pre mean 100 with symmetric spread; post mean 150.
    const preValues = [90, 110, 95, 105, 92, 108, 97, 103, 85, 115, 100, 100, 98, 102];
    const postValues = Array(7).fill(150);

    const result = estimateCounterfactual({ preValues, postValues });

    expect(result.counterfactual).toBeCloseTo(100, 2);
    expect(result.actual).toBe(150);
    expect(result.lift).toBeCloseTo(0.5, 3);
    expect(result.ci[0]).toBeLessThan(50);
    expect(result.ci[1]).toBeGreaterThan(50);
  });

  it('should throw error if insufficient data', () => {
    expect(() =>
      estimateCounterfactual({ preValues: Array(3).fill(1), postValues: Array(2).fill(1) }),
    ).toThrow('Insufficient historical data');
  });

  it('should throw error if missing pre or post data', () => {
    expect(() =>
      estimateCounterfactual({ preValues: Array(15).fill(100), postValues: [] }),
    ).toThrow('Missing data in pre or post period');
    expect(() =>
      estimateCounterfactual({ preValues: [], postValues: Array(15).fill(100) }),
    ).toThrow('Missing data in pre or post period');
  });
});
