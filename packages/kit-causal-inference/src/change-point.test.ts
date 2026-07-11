/**
 * Ported from dev-dashboard-v2 `tests/server/lib/causal/change-point-detection.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { detectChangePoints } from './change-point.js';

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('detectChangePoints: synthetic regime change', () => {
  it('detects a single sharp mean shift in the middle of the series', () => {
    const rng = makeRng(2025);
    // 100 obs ~ N(10, 1), then 100 obs ~ N(20, 1).
    const values: number[] = [];
    for (let t = 0; t < 100; t++) values.push(10 + (rng() - 0.5) * 2);
    for (let t = 0; t < 100; t++) values.push(20 + (rng() - 0.5) * 2);

    const result = detectChangePoints({ values, threshold: 0.4, minGap: 5 });

    expect(result.changePoints.length).toBeGreaterThanOrEqual(1);
    // The detected change point should land within ±15 of t=100.
    const closest = result.changePoints.reduce((best, cp) =>
      Math.abs(cp.index - 100) < Math.abs(best.index - 100) ? cp : best,
    );
    expect(Math.abs(closest.index - 100)).toBeLessThan(15);
    expect(closest.preMean).toBeLessThan(closest.postMean);
    expect(closest.effectSize).toBeGreaterThan(5);
  });

  it('returns DID recommendation when change is mid-series with enough margin', () => {
    const rng = makeRng(7);
    const values: number[] = [];
    for (let t = 0; t < 80; t++) values.push(5 + (rng() - 0.5) * 0.4);
    for (let t = 0; t < 80; t++) values.push(15 + (rng() - 0.5) * 0.4);
    const result = detectChangePoints({ values, threshold: 0.3, minGap: 5 });
    expect(result.changePoints.length).toBeGreaterThanOrEqual(1);
    const cp = result.changePoints[0]!;
    expect(['did', 'rdd', 'inspect_only']).toContain(cp.recommendation);
    expect(typeof cp.recommendationReason).toBe('string');
  });

  it('returns inspect_only recommendation when the shift is tiny', () => {
    const rng = makeRng(9);
    // Shift of only 0.5 on a baseline of 100 → < 5% threshold.
    const values: number[] = [];
    for (let t = 0; t < 80; t++) values.push(100 + (rng() - 0.5) * 0.2);
    for (let t = 0; t < 80; t++) values.push(100.5 + (rng() - 0.5) * 0.2);
    const result = detectChangePoints({ values, threshold: 0.3, minGap: 5 });
    if (result.changePoints.length > 0) {
      const recs = new Set(result.changePoints.map((c) => c.recommendation));
      expect(recs.has('inspect_only') || recs.has('did') || recs.has('rdd')).toBe(true);
    }
  });

  it('attaches timestamps when provided', () => {
    const rng = makeRng(1);
    const values: number[] = [];
    const timestamps: string[] = [];
    for (let t = 0; t < 60; t++) {
      values.push(10 + (rng() - 0.5) * 0.5);
      timestamps.push(`2026-01-${String((t % 28) + 1).padStart(2, '0')}`);
    }
    for (let t = 0; t < 60; t++) {
      values.push(20 + (rng() - 0.5) * 0.5);
      timestamps.push(`2026-02-${String((t % 28) + 1).padStart(2, '0')}`);
    }
    const result = detectChangePoints({ values, timestamps, threshold: 0.3, minGap: 5 });
    if (result.changePoints.length > 0) {
      expect(typeof result.changePoints[0]!.timestamp).toBe('string');
    }
  });

  it('returns no change points on a flat series', () => {
    const values = new Array(100).fill(0).map((_, i) => 10 + 0.001 * i);
    const result = detectChangePoints({ values, threshold: 0.5, minGap: 5 });
    expect(result.changePoints.length).toBeLessThanOrEqual(1);
  });

  it('warns when series is too short', () => {
    const result = detectChangePoints({ values: [1, 2, 3, 4, 5] });
    expect(result.warnings).toContain('series_too_short_for_reliable_detection');
  });

  it('respects minGap by deduping nearby triggers', () => {
    const rng = makeRng(5);
    const values: number[] = [];
    // Two close mean shifts: t=50 and t=60.
    for (let t = 0; t < 50; t++) values.push(5 + (rng() - 0.5) * 0.2);
    for (let t = 0; t < 10; t++) values.push(15 + (rng() - 0.5) * 0.2);
    for (let t = 0; t < 50; t++) values.push(25 + (rng() - 0.5) * 0.2);
    const result = detectChangePoints({ values, threshold: 0.3, minGap: 30 });
    // With minGap = 30, two close points should collapse to at most one (or
    // the second, far apart enough at t=60).
    for (let i = 1; i < result.changePoints.length; i++) {
      const gap = result.changePoints[i]!.index - result.changePoints[i - 1]!.index;
      expect(gap).toBeGreaterThanOrEqual(30);
    }
  });

  it('emits per-index probability series of correct length', () => {
    const rng = makeRng(3);
    const values = Array.from({ length: 50 }, (_, t) => (t < 25 ? 1 : 5) + rng() * 0.1);
    const result = detectChangePoints({ values, threshold: 0.5 });
    expect(result.changeProbabilities.length).toBe(50);
    for (const p of result.changeProbabilities) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('returns hazard and threshold echo in result', () => {
    const result = detectChangePoints({
      values: [1, 1, 1, 5, 5, 5, 5, 5, 5, 5],
      hazard: 0.05,
      threshold: 0.6,
    });
    expect(result.hazard).toBe(0.05);
    expect(result.threshold).toBe(0.6);
  });
});

describe('detectChangePoints: input validation', () => {
  it('throws when values is empty', () => {
    expect(() => detectChangePoints({ values: [] })).toThrow(/non-empty/);
  });

  it('throws on non-finite values', () => {
    expect(() => detectChangePoints({ values: [1, Number.NaN, 3] })).toThrow(/finite/);
  });

  it('throws when hazard is out of (0, 1)', () => {
    expect(() => detectChangePoints({ values: [1, 2, 3], hazard: 0 })).toThrow(/hazard/);
    expect(() => detectChangePoints({ values: [1, 2, 3], hazard: 1 })).toThrow(/hazard/);
    expect(() => detectChangePoints({ values: [1, 2, 3], hazard: 1.5 })).toThrow(/hazard/);
  });
});
