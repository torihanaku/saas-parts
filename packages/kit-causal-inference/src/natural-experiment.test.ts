/**
 * Tests for the pure shock-detection core of the Natural Experiment Detector
 * (origin: dev-dashboard-v2 `server/services/naturalExperimentDetector.ts`;
 * the original tests were Supabase-route oriented, so these exercise the
 * extracted 3-sigma algorithm directly with the same numerics).
 */
import { describe, it, expect } from 'vitest';
import { detectExogenousShocks, type DailyMetricPoint } from './natural-experiment.js';

function makeSeries(values: number[]): DailyMetricPoint[] {
  return values.map((value, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    value,
  }));
}

describe('detectExogenousShocks', () => {
  it('detects a sudden 3-sigma drop against the 21-day baseline', () => {
    // 30 stable days at 100 (tiny deterministic wiggle), then a crash to 20.
    const values: number[] = [];
    for (let i = 0; i < 30; i++) values.push(100 + (i % 3)); // 100/101/102 wiggle
    values.push(20); // day index 30 — far below mean − 3σ
    for (let i = 0; i < 4; i++) values.push(20 + (i % 2));

    const shocks = detectExogenousShocks(makeSeries(values));

    expect(shocks.length).toBeGreaterThanOrEqual(1);
    const first = shocks[0]!;
    expect(first.index).toBe(30);
    expect(first.shockDate).toBe('2026-01-31');
    // liftEstimate = current / baselineMean − 1 ≈ 20/101 − 1 ≈ −0.8
    expect(first.liftEstimate).toBeLessThan(-0.7);
    expect(first.baselineMean).toBeGreaterThan(99);
    // DID windows: pre = [i−7, i−1], post = [i, min(i+6, end)]
    expect(first.prePeriodStart).toBe('2026-01-24');
    expect(first.prePeriodEnd).toBe('2026-01-30');
    expect(first.postPeriodStart).toBe('2026-01-31');
    // post end = dates[min(30+6, 34)] = last label in the series (clamped)
    expect(first.postPeriodEnd).toBe('2026-01-35');
    expect(first.description).toContain('detected on 2026-01-31');
  });

  it('returns [] when the series has fewer than 30 observations', () => {
    const values = Array(29).fill(100);
    expect(detectExogenousShocks(makeSeries(values))).toEqual([]);
  });

  it('returns [] on a stable series with no shocks', () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + (i % 5));
    expect(detectExogenousShocks(makeSeries(values))).toEqual([]);
  });

  it('does not flag upward spikes (drop-only detector, as in the origin)', () => {
    const values: number[] = [];
    for (let i = 0; i < 30; i++) values.push(100 + (i % 3));
    values.push(500); // spike up, not down
    expect(detectExogenousShocks(makeSeries(values))).toEqual([]);
  });
});
