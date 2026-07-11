/**
 * Counterfactual Analyzer — "what would have happened without the
 * intervention", estimated by projecting the pre-period baseline mean.
 *
 * Ported from dev-dashboard-v2 `server/services/counterfactualAnalyzer.ts`.
 * Changes vs. origin: data acquisition (Supabase fetch + date-window slicing
 * into 14-day pre / 7-day post) was dropped — the caller passes the pre- and
 * post-period observation arrays directly. Statistics and rounding unchanged.
 */

import { mean, stdev } from './stats.js';

export interface CounterfactualInput {
  /** Outcome observations from the baseline (pre-intervention) period. */
  preValues: number[];
  /** Outcome observations from the post-intervention period. */
  postValues: number[];
}

export interface CounterfactualResult {
  /** Mean of the post period (2 dp). */
  actual: number;
  /** Projected baseline = mean of the pre period (2 dp). */
  counterfactual: number;
  /** Relative lift = (actual − counterfactual) / counterfactual (4 dp). */
  lift: number;
  /**
   * 95% CI on the *absolute* lift (actual − counterfactual), using the
   * standard error of the pre-period mean (2 dp). Mirrors the origin, which
   * intentionally reports relative lift alongside an absolute-lift CI.
   */
  ci: [number, number];
}

export function estimateCounterfactual(input: CounterfactualInput): CounterfactualResult {
  const { preValues, postValues } = input;

  if (preValues.length + postValues.length < 14) {
    throw new Error('Insufficient historical data for counterfactual analysis');
  }
  if (preValues.length === 0 || postValues.length === 0) {
    throw new Error('Missing data in pre or post period');
  }

  const preMean = mean(preValues);
  const preStdev = stdev(preValues);

  const counterfactual = preMean;
  const actual = mean(postValues);

  const lift = actual - counterfactual;
  const liftPercentage = counterfactual > 0 ? lift / counterfactual : 0;

  // Confidence Interval (95%)
  const se = preStdev / Math.sqrt(preValues.length);
  const ci: [number, number] = [
    lift - 1.96 * (se || 0),
    lift + 1.96 * (se || 0),
  ];

  return {
    actual: Number(actual.toFixed(2)),
    counterfactual: Number(counterfactual.toFixed(2)),
    lift: Number(liftPercentage.toFixed(4)),
    ci: [Number(ci[0].toFixed(2)), Number(ci[1].toFixed(2))],
  };
}
