/**
 * Bayesian Online Change Point Detection (Adams & MacKay, 2007).
 *
 * Ported from 実運用SaaS `server/lib/causal/change-point-detection.ts`
 * (numerics unchanged).
 *
 * Detects abrupt regime shifts in a univariate time series — what marketers
 * call "natural experiments": a competitor pricing change, a TV creative
 * launch, an iOS privacy update, a viral moment. We don't trigger DID/RDD
 * automatically; we just surface the change points with confidence scores
 * plus a recommendation hint.
 *
 * Algorithm sketch (Gaussian-with-known-precision likelihood, constant
 * hazard prior):
 *
 *   1. Maintain a posterior over the *run length* r_t — the number of
 *      consecutive points since the last change.
 *   2. At each new observation x_t:
 *        a. Compute predictive probability π(x_t | r_{t-1}) under each run
 *           length using the Gaussian sufficient stats accumulated so far.
 *        b. Growth probability: P(r_t = r_{t-1}+1) = π · (1 − H)
 *        c. Change probability: P(r_t = 0)        = Σ π · H
 *        d. Renormalise to a proper distribution.
 *   3. After the full pass, mark t as a change point iff
 *        P(r_t = 0 | x_{1..t}) ≥ threshold.
 *
 * Hazard H is a constant (default 1/100 — expect a regime change roughly
 * every 100 obs). For a more adaptive setup we'd use a logistic hazard, but
 * constant hazard performs well on the marketing time-series we tested
 * against (daily revenue, daily CTR over 365–730 days).
 *
 * We could implement PELT (Pruned Exact Linear Time) instead — it's faster
 * for very long series — but BOCD gives a per-point posterior probability,
 * not just a binary label. That probability drives the confidence column in
 * the UI.
 */

import { mean, variance } from './stats.js';

export interface ChangePointInput {
  /** Time series values, one per period. */
  values: number[];
  /** Optional ISO timestamps aligned with `values` (UI display only). */
  timestamps?: string[];
  /** Hazard parameter (constant). Default 0.01 (≈ 1 change per 100 obs). */
  hazard?: number;
  /** Posterior threshold to call a change point. Default 0.5. */
  threshold?: number;
  /** Minimum gap between two reported change points (in periods). Default 7. */
  minGap?: number;
}

export interface ChangePoint {
  index: number;
  /** ISO timestamp from `timestamps[index]` if provided. */
  timestamp?: string;
  /** Posterior probability that t is a change point. */
  probability: number;
  /** Mean of the run *before* the change point. */
  preMean: number;
  /** Mean of the segment *after* (up to next change or end). */
  postMean: number;
  /** Estimated effect size = postMean − preMean. */
  effectSize: number;
  /** Suggested follow-up analysis. */
  recommendation: 'did' | 'rdd' | 'inspect_only';
  recommendationReason: string;
}

export interface ChangePointOutput {
  changePoints: ChangePoint[];
  /** Per-index change-probability series (length = values.length). */
  changeProbabilities: number[];
  hazard: number;
  threshold: number;
  warnings: string[];
}

/** Online Gaussian sufficient stats per run-length cell. */
interface GaussianStats {
  n: number;
  mean: number;
  m2: number; // running sum of squared deviations (Welford)
}

function welfordUpdate(s: GaussianStats, x: number): GaussianStats {
  const n = s.n + 1;
  const delta = x - s.mean;
  const newMean = s.mean + delta / n;
  const m2 = s.m2 + delta * (x - newMean);
  return { n, mean: newMean, m2 };
}

/**
 * Predictive log-density under a Gaussian with parameters from the run's
 * sufficient stats. For an empty run (n = 0) we use the *prior* mean and
 * an inflated variance so a fresh segment doesn't have to compete against
 * a fully-fitted Gaussian centred on the wrong value.
 *
 * Without this inflation, P(r_t = 0) collapses to the hazard parameter alone
 * (the new-run predictive becomes vanishingly small whenever the prior mean
 * differs from x_t), and BOCD never reports any change points.
 */
function predictiveLogProb(
  s: GaussianStats,
  x: number,
  priorMean: number,
  priorVar: number,
): number {
  if (s.n === 0) {
    // Fresh run — non-informative prior centred on the dataset mean with the
    // dataset variance. This is the standard "empirical Bayes" choice for
    // BOCD when no genuine prior is supplied.
    const diff = x - priorMean;
    const v = priorVar;
    return -0.5 * (Math.log(2 * Math.PI * v) + (diff * diff) / v);
  }
  const v = s.n >= 2 ? Math.max(s.m2 / Math.max(s.n - 1, 1), 1e-12) : priorVar;
  const mu = s.mean;
  const diff = x - mu;
  return -0.5 * (Math.log(2 * Math.PI * v) + (diff * diff) / v);
}

function logSumExp(arr: number[]): number {
  if (arr.length === 0) return -Infinity;
  let max = -Infinity;
  for (const v of arr) if (v > max) max = v;
  if (!Number.isFinite(max)) return max;
  let sum = 0;
  for (const v of arr) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

export function detectChangePoints(input: ChangePointInput): ChangePointOutput {
  const warnings: string[] = [];
  const values = input.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('detectChangePoints: values must be a non-empty array');
  }
  for (const v of values) {
    if (!Number.isFinite(v)) {
      throw new Error('detectChangePoints: values must be finite numbers');
    }
  }
  const T = values.length;
  if (T < 10) {
    warnings.push('series_too_short_for_reliable_detection');
  }
  const hazard = input.hazard ?? 0.01;
  if (!(hazard > 0 && hazard < 1)) {
    throw new Error('detectChangePoints: hazard must be in (0, 1)');
  }
  const threshold = input.threshold ?? 0.5;
  const minGap = Math.max(1, input.minGap ?? 7);

  const priorMean = mean(values);
  const priorVar = Math.max(variance(values), 1e-6);
  const logH = Math.log(hazard);
  const log1mH = Math.log(1 - hazard);

  // Run-length posterior, stored in log space. logRL[r] is the log prob of
  // run length r at time t. Truncate at length T so memory stays O(T²) in
  // the worst case (acceptable for our marketing series ≤ 730 obs).
  let logRL: number[] = [0]; // P(r_0 = 0) = 1
  let stats: GaussianStats[] = [{ n: 0, mean: 0, m2: 0 }];

  const changeProb: number[] = new Array(T).fill(0);

  for (let t = 0; t < T; t++) {
    const x = values[t]!;
    // Predictive under each existing run's posterior (used for "growth").
    const predLogProbsExisting = stats.map((s) =>
      predictiveLogProb(s, x, priorMean, priorVar),
    );
    // Predictive under the prior (used for "change to fresh run").
    const predLogProbFresh = predictiveLogProb(
      { n: 0, mean: 0, m2: 0 },
      x,
      priorMean,
      priorVar,
    );

    // Growth: r_t = r_{t-1} + 1 with prob (1 − hazard).
    // Likelihood uses the existing run's posterior.
    const growth = logRL.map((lp, r) => lp + predLogProbsExisting[r]! + log1mH);
    // Change: r_t = 0. Likelihood uses the *prior* — the new segment has no
    // history yet, so we evaluate x_t under the empirical-Bayes prior. This
    // is the BOCD specialisation of MacKay & Adams 2007 §2.2.
    const changeLog = predLogProbFresh + logH + logSumExp(logRL);

    const newLogRL: number[] = new Array(growth.length + 1);
    newLogRL[0] = changeLog;
    for (let r = 0; r < growth.length; r++) newLogRL[r + 1] = growth[r]!;

    // Normalise.
    const norm = logSumExp(newLogRL);
    for (let r = 0; r < newLogRL.length; r++) newLogRL[r]! -= norm;

    // Update sufficient stats: index r in *new* logRL was index r-1 (or 0 for
    // r=0 — fresh run).
    const newStats: GaussianStats[] = new Array(newLogRL.length);
    newStats[0] = { n: 0, mean: 0, m2: 0 };
    for (let r = 0; r < stats.length; r++) {
      newStats[r + 1] = welfordUpdate(stats[r]!, x);
    }

    logRL = newLogRL;
    stats = newStats;
    changeProb[t] = Math.exp(logRL[0]!);
  }

  // Convert probability series to discrete change points respecting minGap.
  const candidates: number[] = [];
  for (let t = 0; t < T; t++) {
    if (changeProb[t]! >= threshold) candidates.push(t);
  }
  const accepted: number[] = [];
  for (const idx of candidates) {
    if (accepted.length === 0 || idx - accepted[accepted.length - 1]! >= minGap) {
      accepted.push(idx);
    } else if (
      changeProb[idx]! > changeProb[accepted[accepted.length - 1]!]!
    ) {
      // Replace last with the higher-probability one in the same window.
      accepted[accepted.length - 1] = idx;
    }
  }

  // Build result objects with pre/post means and recommendations.
  const cps: ChangePoint[] = accepted.map((idx, i) => {
    const prevIdx = i === 0 ? 0 : accepted[i - 1]!;
    const nextIdx = i === accepted.length - 1 ? T : accepted[i + 1]!;
    const preMean = mean(values.slice(prevIdx, idx));
    const postMean = mean(values.slice(idx, nextIdx));
    const effect = postMean - preMean;
    const rec = chooseRecommendation(idx, effect, preMean, postMean, T);
    return {
      index: idx,
      timestamp: input.timestamps?.[idx],
      probability: changeProb[idx]!,
      preMean,
      postMean,
      effectSize: effect,
      recommendation: rec.method,
      recommendationReason: rec.reason,
    };
  });

  return {
    changePoints: cps,
    changeProbabilities: changeProb,
    hazard,
    threshold,
    warnings,
  };
}

function chooseRecommendation(
  idx: number,
  effect: number,
  preMean: number,
  _postMean: number,
  T: number,
): { method: ChangePoint['recommendation']; reason: string } {
  // Heuristics — kept intentionally simple to avoid auto-triggering the
  // wrong analysis. The UI surfaces this as a hint, not a directive.
  if (Math.abs(effect) < 0.05 * Math.abs(preMean)) {
    return {
      method: 'inspect_only',
      reason: 'effect < 5% of pre-period mean — may be noise; visual inspection first',
    };
  }
  // If the change is far from both ends we can build a clean DID with the
  // surrounding segments as treatment / control halves.
  if (idx > 30 && T - idx > 30) {
    return {
      method: 'did',
      reason: 'sufficient pre/post data (> 30 obs each) — DID is the natural follow-up',
    };
  }
  // Near a boundary → not enough data on one side for DID, but the change
  // itself is a sharp threshold → RDD-style local-linear at the change point
  // gives a cleaner LATE.
  return {
    method: 'rdd',
    reason: 'change point near boundary → use local-linear RDD at the change index',
  };
}
