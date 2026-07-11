/**
 * MAPE (Mean Absolute Percentage Error) tracking and drift detection —
 * the algorithm parts of the prediction-accuracy jobs.
 *
 * Ported from dev-dashboard-v2 `server/jobs/whatifMapeTracker.ts` and
 * `server/jobs/mape-drift-check.ts`. Changes vs. origin: data acquisition
 * (Supabase queries over `dd_content_performance` / `dd_prediction_accuracy`)
 * and side effects (Sentry alert, `dd_events` insert, logging) were dropped —
 * the caller passes raw values and reacts to the returned drift list.
 * Numerics (naive baseline-mean prediction, APE, 4-dp rounding, 30% drift
 * threshold, per-group averaging) unchanged.
 */

/**
 * Absolute percentage error of a single prediction. Returns null when the
 * actual is 0 (APE undefined) — mirrors the origin's `computeMape`.
 */
export function computeMape(actual: number, predicted: number): number | null {
  if (actual === 0) return null;
  return Math.abs((actual - predicted) / actual);
}

export interface BaselineMapeRecord {
  /** Mean of the recent (observed) values, 4 dp. */
  actualValue: number;
  /** Mean of the baseline values, used as the naive prediction, 4 dp. */
  predictedValue: number;
  /** APE of the naive prediction, 4 dp. */
  mape: number;
}

/**
 * Naive-baseline MAPE for one metric: the mean of the baseline window is
 * used as the "prediction" for the mean of the recent window. This is the
 * naive-forecast benchmark; a real simulator can override `predictedValue`.
 *
 * Returns null when either window is empty or the recent mean is 0.
 */
export function computeBaselineMape(
  recentValues: number[],
  baselineValues: number[],
): BaselineMapeRecord | null {
  if (recentValues.length === 0 || baselineValues.length === 0) return null;
  const actual = recentValues.reduce((s, v) => s + v, 0) / recentValues.length;
  const predicted = baselineValues.reduce((s, v) => s + v, 0) / baselineValues.length;
  const mape = computeMape(actual, predicted);
  if (mape === null) return null;
  return {
    actualValue: Number(actual.toFixed(4)),
    predictedValue: Number(predicted.toFixed(4)),
    mape: Number(mape.toFixed(4)),
  };
}

export interface MapeObservation {
  /** Grouping key (the origin grouped by tenant). */
  groupId: string;
  /** One measured MAPE value (0.1 = 10%). */
  mape: number;
}

export interface MapeDrift {
  groupId: string;
  /** Average MAPE over the group's observations. */
  avgMape: number;
  /** Number of observations averaged. */
  sampleCount: number;
}

/** Default drift threshold: average MAPE > 30% ⇒ re-training recommended. */
export const DEFAULT_MAPE_DRIFT_THRESHOLD = 0.30;

/**
 * Aggregate MAPE observations per group and flag groups whose average MAPE
 * exceeds the threshold. The origin raised a Sentry warning and inserted a
 * `re_training_needed` event per drifted tenant; here the caller does that
 * with the returned list.
 */
export function detectMapeDrift(
  observations: MapeObservation[],
  threshold: number = DEFAULT_MAPE_DRIFT_THRESHOLD,
): MapeDrift[] {
  const groups: Record<string, { total: number; count: number }> = {};
  for (const obs of observations) {
    const g = groups[obs.groupId] ?? { total: 0, count: 0 };
    g.total += Number(obs.mape);
    g.count += 1;
    groups[obs.groupId] = g;
  }

  const drifted: MapeDrift[] = [];
  for (const [groupId, stats] of Object.entries(groups)) {
    const avgMape = stats.total / stats.count;
    if (avgMape > threshold) {
      drifted.push({ groupId, avgMape, sampleCount: stats.count });
    }
  }
  return drifted;
}
