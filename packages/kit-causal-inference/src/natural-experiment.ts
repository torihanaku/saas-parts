/**
 * Natural Experiment Detector — scans a daily metric series for exogenous
 * shocks (3-sigma drops vs. a rolling 21-day baseline) and proposes DID
 * pre/post windows around each shock.
 *
 * Ported from dev-dashboard-v2 `server/services/naturalExperimentDetector.ts`.
 * Changes vs. origin: data acquisition (Supabase fetch + per-day aggregation)
 * and persistence (dedup lookup + insert into `dd_natural_experiments`, plus
 * the hard-coded placeholder p_value) were dropped — the caller passes the
 * aggregated daily series and handles storage/dedup. Detection numerics
 * (window = 21 days, threshold = mean − 3σ with mean > 0) unchanged.
 */

import { mean, stdev } from './stats.js';

export interface DailyMetricPoint {
  /** ISO date (YYYY-MM-DD) or any sortable period label. */
  date: string;
  /** Aggregated metric value for that day. */
  value: number;
}

export interface DetectedShock {
  /** Index into the input series where the shock occurred. */
  index: number;
  shockDate: string;
  /** Relative drop: value / baselineMean − 1 (negative for drops). */
  liftEstimate: number;
  baselineMean: number;
  baselineStdev: number;
  /** Suggested DID windows around the shock (mirrors the origin's layout). */
  prePeriodStart: string;
  prePeriodEnd: string;
  postPeriodStart: string;
  postPeriodEnd: string;
  /** Human-readable summary, e.g. "Sudden metric drop (-42%) detected on …". */
  description: string;
}

export interface ShockDetectionOptions {
  /** Rolling baseline window length in periods. Default 21. */
  baselineWindow?: number;
  /** Number of sigmas below the baseline mean that counts as a shock. Default 3. */
  sigmaThreshold?: number;
  /** Minimum series length before scanning. Default 30 (matches origin). */
  minObservations?: number;
}

/**
 * Scan an ascending-ordered daily series for sudden drops. For each index
 * i ≥ baselineWindow, the preceding `baselineWindow` values form the baseline;
 * a shock is flagged when value < mean − sigmaThreshold·σ and mean > 0.
 */
export function detectExogenousShocks(
  series: DailyMetricPoint[],
  options: ShockDetectionOptions = {},
): DetectedShock[] {
  const baselineWindow = options.baselineWindow ?? 21;
  const sigmaThreshold = options.sigmaThreshold ?? 3;
  const minObservations = options.minObservations ?? 30;

  if (!Array.isArray(series) || series.length < minObservations) return [];

  const dates = series.map((p) => p.date);
  const values = series.map((p) => p.value);
  const found: DetectedShock[] = [];

  for (let i = baselineWindow; i < values.length; i++) {
    const baseline = values.slice(i - baselineWindow, i);
    const m = mean(baseline);
    const s = stdev(baseline);
    const current = values[i]!;

    // If drop is more than `sigmaThreshold` sigma (sudden drop)
    if (current < m - sigmaThreshold * s && m > 0) {
      const shockDate = dates[i]!;
      found.push({
        index: i,
        shockDate,
        liftEstimate: current / m - 1,
        baselineMean: m,
        baselineStdev: s,
        prePeriodStart: dates[i - 7] ?? dates[0]!,
        prePeriodEnd: dates[i - 1]!,
        postPeriodStart: shockDate,
        postPeriodEnd: dates[Math.min(i + 6, values.length - 1)]!,
        description: `Sudden metric drop (${Math.round((current / m - 1) * 100)}%) detected on ${shockDate}.`,
      });
    }
  }

  return found;
}
