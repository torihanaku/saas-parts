/**
 * Ported from dev-dashboard-v2 `tests/server/lib/causal/mmm/saturation.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  hill,
  saturate,
  saturationCurvePoints,
  saturationPoint,
  weibull,
  SHAPE_GRID_HILL,
  SHAPE_GRID_WEIBULL,
} from './mmm-saturation.js';

describe('hill saturation', () => {
  it('returns 0 at x = 0', () => {
    expect(hill(0, 100, 1)).toBe(0);
  });

  it('returns 0.5 at x = K (half-saturation by definition)', () => {
    expect(hill(100, 100, 1)).toBeCloseTo(0.5, 6);
    expect(hill(50, 50, 2)).toBeCloseTo(0.5, 6);
  });

  it('asymptotes to 1 for very large x', () => {
    expect(hill(1e9, 100, 1)).toBeGreaterThan(0.999);
  });

  it('clamps negative or non-finite x to 0', () => {
    expect(hill(-10, 100, 1)).toBe(0);
    expect(hill(Number.NaN, 100, 1)).toBe(0);
  });

  it('returns 0 on invalid params', () => {
    expect(hill(50, 0, 1)).toBe(0);
    expect(hill(50, -10, 1)).toBe(0);
    expect(hill(50, 100, 0)).toBe(0);
  });
});

describe('weibull saturation', () => {
  it('returns 0 at x = 0', () => {
    expect(weibull(0, 100, 1)).toBe(0);
  });

  it('approaches 1 for very large x', () => {
    expect(weibull(1e9, 100, 1)).toBeGreaterThan(0.999);
  });

  it('returns 1 - 1/e ≈ 0.632 at x = lambda when k = 1', () => {
    expect(weibull(100, 100, 1)).toBeCloseTo(1 - 1 / Math.E, 6);
  });

  it('clamps negative or non-finite x to 0', () => {
    expect(weibull(-1, 100, 1)).toBe(0);
    expect(weibull(Number.NaN, 100, 1)).toBe(0);
  });

  it('returns 0 on invalid params', () => {
    expect(weibull(50, 0, 1)).toBe(0);
    expect(weibull(50, 100, 0)).toBe(0);
  });
});

describe('saturate (form dispatch)', () => {
  it('routes "hill" to hill()', () => {
    const xs = [0, 50, 100];
    const out = saturate(xs, 'hill', { shape: 1, scale: 100 });
    expect(out[0]).toBe(0);
    expect(out[2]).toBeCloseTo(0.5, 6);
  });

  it('routes "weibull" to weibull()', () => {
    const xs = [100];
    const out = saturate(xs, 'weibull', { shape: 1, scale: 100 });
    expect(out[0]).toBeCloseTo(1 - 1 / Math.E, 6);
  });

  it('throws on unknown form', () => {
    // @ts-expect-error — intentional bad input
    expect(() => saturate([1], 'logistic', { shape: 1, scale: 1 })).toThrow();
  });
});

describe('saturationPoint', () => {
  it('returns scale (= K) for Hill', () => {
    expect(saturationPoint('hill', { shape: 2, scale: 75 })).toBe(75);
  });

  it('returns scale for Weibull when k <= 1 (degenerate)', () => {
    expect(saturationPoint('weibull', { shape: 1, scale: 50 })).toBe(50);
    expect(saturationPoint('weibull', { shape: 0.7, scale: 30 })).toBe(30);
  });

  it('returns 1.5 × inflection for Weibull k > 1', () => {
    const k = 2;
    const lambda = 100;
    const xStar = lambda * Math.pow((k - 1) / k, 1 / k);
    expect(saturationPoint('weibull', { shape: k, scale: lambda })).toBeCloseTo(
      1.5 * xStar,
      6,
    );
  });

  it('returns scale (defensive) when params are degenerate', () => {
    expect(saturationPoint('weibull', { shape: 0, scale: 100 })).toBe(100);
  });
});

describe('saturationCurvePoints', () => {
  it('returns N+1 points spanning [0, maxSpend × headroom]', () => {
    const points = saturationCurvePoints('hill', { shape: 1, scale: 100 }, 200, 1, 50, 1.3);
    expect(points.length).toBe(51);
    expect(points[0]!.spend).toBe(0);
    expect(points[points.length - 1]!.spend).toBeCloseTo(200 * 1.3, 6);
  });

  it('contribution monotonically non-decreasing in spend (Hill)', () => {
    const points = saturationCurvePoints('hill', { shape: 1, scale: 100 }, 200, 5);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.contribution).toBeGreaterThanOrEqual(points[i - 1]!.contribution - 1e-9);
    }
  });

  it('uses upper bound 1 when maxObservedSpend is 0 (defensive)', () => {
    const points = saturationCurvePoints('hill', { shape: 1, scale: 1 }, 0, 1, 10);
    expect(points[points.length - 1]!.spend).toBeCloseTo(1.3, 6);
  });

  it('also works with Weibull', () => {
    const points = saturationCurvePoints('weibull', { shape: 2, scale: 100 }, 200, 3);
    expect(points.length).toBe(51);
    expect(points[0]!.contribution).toBe(0);
    expect(points[points.length - 1]!.contribution).toBeGreaterThan(0);
  });
});

describe('shape grids', () => {
  it('Hill grid is sorted ascending and positive', () => {
    for (let i = 1; i < SHAPE_GRID_HILL.length; i++) {
      expect(SHAPE_GRID_HILL[i]!).toBeGreaterThan(SHAPE_GRID_HILL[i - 1]!);
    }
    for (const v of SHAPE_GRID_HILL) expect(v).toBeGreaterThan(0);
  });

  it('Weibull grid is sorted ascending and positive', () => {
    for (let i = 1; i < SHAPE_GRID_WEIBULL.length; i++) {
      expect(SHAPE_GRID_WEIBULL[i]!).toBeGreaterThan(SHAPE_GRID_WEIBULL[i - 1]!);
    }
    for (const v of SHAPE_GRID_WEIBULL) expect(v).toBeGreaterThan(0);
  });
});
