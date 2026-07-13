/**
 * Regression comparison between two eval runs.
 *
 * Concept adopted from 実運用SaaS `tools/eval-lab` (the Python
 * experiment lab compared experiments stored in SQLite across model
 * versions); implemented here as pure functions over
 * {@link ClassificationMetrics} so any storage can feed it.
 */

import type { ClassificationMetrics } from "./metrics";

export const COMPARABLE_METRICS = ["precision", "recall", "f1", "accuracy"] as const;
export type ComparableMetric = (typeof COMPARABLE_METRICS)[number];

export interface MetricDelta {
  metric: ComparableMetric;
  baseline: number;
  current: number;
  /** current - baseline (positive = improvement). */
  delta: number;
}

export interface RunComparison {
  deltas: MetricDelta[];
  /** Metrics that dropped by more than `tolerance`. */
  regressions: MetricDelta[];
  /** Metrics that improved by more than `tolerance`. */
  improvements: MetricDelta[];
  /** True when no metric regressed beyond tolerance. */
  passed: boolean;
}

export interface CompareOptions {
  /**
   * Allowed drop before a metric counts as a regression. Default 0
   * (any drop is a regression). E.g. 0.01 tolerates a 1pt F1 dip.
   */
  tolerance?: number;
  /** Metrics to compare. Default: precision / recall / f1 / accuracy. */
  metrics?: ComparableMetric[];
}

/**
 * Compare a current run against a baseline run.
 *
 * ```ts
 * const baseline = computeClassificationMetrics(previousPairs);
 * const current = computeClassificationMetrics(newPairs);
 * const cmp = compareRuns(baseline, current, { tolerance: 0.01 });
 * if (!cmp.passed) failCiBuild(cmp.regressions);
 * ```
 */
export function compareRuns(
  baseline: Pick<ClassificationMetrics, ComparableMetric>,
  current: Pick<ClassificationMetrics, ComparableMetric>,
  options: CompareOptions = {},
): RunComparison {
  const tolerance = options.tolerance ?? 0;
  const metrics = options.metrics ?? [...COMPARABLE_METRICS];

  const deltas: MetricDelta[] = metrics.map((metric) => ({
    metric,
    baseline: baseline[metric],
    current: current[metric],
    delta: current[metric] - baseline[metric],
  }));

  const regressions = deltas.filter((d) => d.delta < -tolerance);
  const improvements = deltas.filter((d) => d.delta > tolerance);

  return { deltas, regressions, improvements, passed: regressions.length === 0 };
}
