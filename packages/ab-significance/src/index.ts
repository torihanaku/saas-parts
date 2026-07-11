/**
 * Bayesian significance test for A/B testing winner decision.
 * Ported from dev-dashboard-v2 `server/lib/ab-testing/significance.ts`.
 *
 * Approach: each variant carries a Beta(alpha, beta) posterior over its
 * conversion rate. We approximate the 95% credible interval (CI) per
 * variant via a Beta-quantile lookup, then declare a winner when:
 *
 *   - the leading variant's CI lower bound is greater than every other
 *     variant's CI upper bound, AND
 *   - the leading variant has at least `minImpressions` samples.
 *
 * If the CIs overlap, we return `still_running` so the experiment stays
 * live. The complementary allocation side (Thompson sampling / posterior
 * best probability) lives in `@torihanaku/thompson-bandit`; this module
 * provides the CI-overlap winner rule.
 *
 * Beta quantile is computed via a normal approximation
 * (mean + std * probit), which is accurate for moderate alpha/beta.
 * Pure TS — no scipy/jstat dependency.
 */

export interface BetaPosterior {
  id: string;
  alpha: number;
  beta: number;
  /** Number of impressions / trials behind this posterior. */
  impressions: number;
}

export interface SignificanceResult {
  status: "winner" | "still_running" | "insufficient_samples";
  winnerId: string | null;
  /** Per-variant 95% credible interval (mean, lower, upper). */
  intervals: Array<{
    id: string;
    mean: number;
    ciLower: number;
    ciUpper: number;
  }>;
  /** Diagnostic message for the UI. */
  reason: string;
}

const DEFAULT_MIN_IMPRESSIONS = 100;
const DEFAULT_CI_PROB = 0.95;

/**
 * Inverse standard normal CDF (probit) via Acklam's rational approximation.
 * Accurate to ~1.15e-9 over [0, 1].
 */
function probit(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ] as const;
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ] as const;
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ] as const;
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ] as const;
  const plow = 0.02425;
  const phigh = 1 - plow;

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * Beta(α, β) quantile via normal approximation (μ + σ·z).
 * For α, β > 0; clamps to [0, 1].
 */
export function betaQuantile(alpha: number, beta: number, p: number): number {
  if (alpha <= 0 || beta <= 0) throw new Error("alpha/beta must be > 0");
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // Mean and variance of Beta(α, β).
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const std = Math.sqrt(variance);
  // Normal approximation for moderate α, β: x ≈ μ + σ · z.
  const z = probit(p);
  const x = mean + std * z;
  return Math.max(0, Math.min(1, x));
}

/**
 * Compute the (1-α/2, 1-α/2) credible interval for Beta(alpha, beta).
 */
export function betaCredibleInterval(
  alphaParam: number,
  betaParam: number,
  prob: number = DEFAULT_CI_PROB,
): { mean: number; lower: number; upper: number } {
  const tail = (1 - prob) / 2;
  const lower = betaQuantile(alphaParam, betaParam, tail);
  const upper = betaQuantile(alphaParam, betaParam, 1 - tail);
  const mean = alphaParam / (alphaParam + betaParam);
  return { mean, lower, upper };
}

/**
 * Decide a winner using non-overlapping credible intervals.
 *
 * - All variants must have >= minImpressions, otherwise `insufficient_samples`.
 * - Compute 95% CI per variant.
 * - The variant with the highest posterior mean is the candidate.
 * - If candidate's lower bound > every other candidate's upper bound: winner.
 * - Otherwise: still_running (CIs overlap).
 */
export function decideSignificance(
  variants: BetaPosterior[],
  minImpressions: number = DEFAULT_MIN_IMPRESSIONS,
  ciProb: number = DEFAULT_CI_PROB,
): SignificanceResult {
  if (variants.length < 2) {
    return {
      status: "insufficient_samples",
      winnerId: null,
      intervals: [],
      reason: "need_at_least_two_variants",
    };
  }

  const intervals = variants.map((v) => {
    const { mean, lower, upper } = betaCredibleInterval(v.alpha, v.beta, ciProb);
    return { id: v.id, mean, ciLower: lower, ciUpper: upper };
  });

  if (variants.some((v) => v.impressions < minImpressions)) {
    return {
      status: "insufficient_samples",
      winnerId: null,
      intervals,
      reason: `min_impressions_${minImpressions}_not_met`,
    };
  }

  // Candidate = highest posterior mean.
  const candidate = intervals.reduce((best, cur) => (cur.mean > best.mean ? cur : best));

  // Winner if candidate's lower bound exceeds every other variant's upper bound.
  const dominates = intervals.every(
    (other) => other.id === candidate.id || candidate.ciLower > other.ciUpper,
  );

  if (dominates) {
    return {
      status: "winner",
      winnerId: candidate.id,
      intervals,
      reason: "ci_dominates_all_others",
    };
  }
  return {
    status: "still_running",
    winnerId: null,
    intervals,
    reason: "ci_overlap_no_clear_winner",
  };
}

// Internal exports for testing only.
export const __testing = { probit, DEFAULT_MIN_IMPRESSIONS, DEFAULT_CI_PROB };
