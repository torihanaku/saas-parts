/**
 * Imbens-Kalyanaraman (2012) optimal bandwidth selection for sharp RDD.
 *
 * Ported from dev-dashboard-v2 `server/lib/causal/rdd/bandwidth.ts`.
 *
 * Silverman's rule (used in `rdd.ts`) is plug-and-play but has no
 * RDD-specific properties — it under-smooths when the second derivative of
 * E[y|x] is small near the cutoff and over-smooths the opposite case. IK
 * minimises the asymptotic mean-squared-error of the local-linear treatment
 * effect estimator at the cutoff:
 *
 *   h_IK = C_K · ((σ²_+(c) + σ²_−(c)) / (f(c) · (m''_+(c) − m''_−(c))²))^(1/5) · n^(−1/5)
 *
 * with C_K = 3.4375 for the triangular kernel (rectangular: 5.40; we report
 * 3.4375 as the canonical IK paper choice — local-linear with triangular
 * kernel is the standard).
 *
 * We implement a closed-form approximation that:
 *   1. Estimates the conditional outcome variance σ²_±(c) by local OLS within
 *      a pilot bandwidth (Silverman) on each side.
 *   2. Estimates the running-variable density f(c) by a simple histogram /
 *      uniform-kernel density at the cutoff.
 *   3. Estimates m''_±(c) — the second derivative of E[y|x] at the cutoff —
 *      via a local quadratic fit on each side within the pilot bandwidth.
 *
 * This is faithful to the paper's first-stage approximation. We deliberately
 * skip the regularisation correction term (Calonico–Cattaneo–Titiunik 2014):
 * it gives slightly tighter coverage but adds another ~120 lines of pure
 * numerics for marginal benefit at the file-size budget.
 */

import { linearRegression, mean, stdev } from './stats.js';

const TRIANGULAR_KERNEL_CONST = 3.4375;

export type BandwidthMethod = 'user' | 'silverman' | 'imbens_kalyanaraman';

export interface IkBandwidthResult {
  bandwidth: number;
  method: BandwidthMethod;
  /** Pilot bandwidth used to estimate σ², m''(c), and f(c). */
  pilotBandwidth: number;
  /** Estimated density at the cutoff (uniform kernel). */
  densityAtCutoff: number;
  /** Estimated conditional outcome variances on each side of cutoff. */
  varianceLeft: number;
  varianceRight: number;
  /** Squared difference of the second-derivative estimates (the IK numerator's
   *  curvature term). When small, the bandwidth widens. */
  curvatureSquared: number;
  warnings: string[];
}

export function silvermanBandwidth(xs: number[]): number {
  if (xs.length < 2) return 0;
  const sigma = stdev(xs);
  if (sigma === 0) return 0;
  return 1.06 * sigma * Math.pow(xs.length, -1 / 5);
}

/**
 * Local quadratic regression on (x, y) with x re-centred on the cutoff. We
 * solve a 3x3 system rather than reaching for `linearRegression` because we
 * need the y-intercept's second-derivative coefficient (β₂ × 2).
 */
function localQuadraticSecondDerivative(
  xs: number[],
  ys: number[],
  cutoff: number,
): number | null {
  const n = xs.length;
  if (n < 3) return null;
  // Build the normal equations for y = β₀ + β₁(x−c) + β₂(x−c)²/2 (Taylor form
  // — coefficient of (x−c)² is m''(c)/2, so m''(c) = 2β₂).
  const s0 = n;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let sy = 0;
  let sy1 = 0;
  let sy2 = 0;
  for (let i = 0; i < n; i++) {
    const u = xs[i]! - cutoff;
    const u2 = u * u;
    s1 += u;
    s2 += u2;
    s3 += u * u2;
    s4 += u2 * u2;
    sy += ys[i]!;
    sy1 += u * ys[i]!;
    sy2 += u2 * ys[i]!;
  }
  // Symmetric 3×3 normal-equation matrix for (β₀, β₁, β₂_half) with
  // X column 3 = (x−c)²/2:
  const A: number[][] = [
    [s0,       s1,       s2 / 2],
    [s1,       s2,       s3 / 2],
    [s2 / 2,   s3 / 2,   s4 / 4],
  ];
  const b: number[] = [sy, sy1, sy2 / 2];
  const det =
    A[0]![0]! * (A[1]![1]! * A[2]![2]! - A[1]![2]! * A[2]![1]!) -
    A[0]![1]! * (A[1]![0]! * A[2]![2]! - A[1]![2]! * A[2]![0]!) +
    A[0]![2]! * (A[1]![0]! * A[2]![1]! - A[1]![1]! * A[2]![0]!);
  if (Math.abs(det) < 1e-12) return null;
  // Cramer's rule for β₂_half (3rd unknown).
  const A3: number[][] = [
    [A[0]![0]!, A[0]![1]!, b[0]!],
    [A[1]![0]!, A[1]![1]!, b[1]!],
    [A[2]![0]!, A[2]![1]!, b[2]!],
  ];
  const det3 =
    A3[0]![0]! * (A3[1]![1]! * A3[2]![2]! - A3[1]![2]! * A3[2]![1]!) -
    A3[0]![1]! * (A3[1]![0]! * A3[2]![2]! - A3[1]![2]! * A3[2]![0]!) +
    A3[0]![2]! * (A3[1]![0]! * A3[2]![1]! - A3[1]![1]! * A3[2]![0]!);
  // The third regressor is u²/2 (Taylor form), so its coefficient *equals*
  // m''(c) directly — no extra factor needed.
  return det3 / det;
}

/**
 * Conditional residual variance from a local-linear fit on one side of the
 * cutoff. Used as σ²_±(c) in the IK formula.
 */
function localResidualVariance(xs: number[], ys: number[]): number | null {
  if (xs.length < 3) return null;
  try {
    const fit = linearRegression(xs, ys);
    return fit.residualVariance;
  } catch {
    return null;
  }
}

/**
 * Crude density-at-cutoff estimate. Uses a uniform kernel of half-width h
 * (the pilot bandwidth) to count observations in [c−h, c+h] and divides by
 * 2h·n. This converges at the right rate for the IK plug-in formula
 * (we don't need the constant exactly).
 */
function densityAtCutoff(xs: number[], cutoff: number, h: number): number {
  if (h <= 0 || xs.length === 0) return 0;
  let count = 0;
  for (const x of xs) {
    if (x >= cutoff - h && x <= cutoff + h) count++;
  }
  return count / (2 * h * xs.length);
}

/**
 * Compute the IK optimal bandwidth from the given (x, y) observations and
 * cutoff. Falls back to Silverman if any of the plug-in components fail
 * (insufficient data on a side, zero curvature, etc.) — the warnings array
 * tells the caller which fallback was triggered.
 */
export function imbensKalyanaramanBandwidth(
  xs: number[],
  ys: number[],
  cutoff: number,
): IkBandwidthResult {
  const warnings: string[] = [];
  const fallback: IkBandwidthResult = {
    bandwidth: 0,
    method: 'silverman',
    pilotBandwidth: 0,
    densityAtCutoff: 0,
    varianceLeft: 0,
    varianceRight: 0,
    curvatureSquared: 0,
    warnings,
  };

  if (xs.length !== ys.length) {
    throw new Error('imbensKalyanaramanBandwidth: xs/ys length mismatch');
  }
  if (xs.length < 10) {
    warnings.push('too_few_observations_for_ik');
    fallback.bandwidth = silvermanBandwidth(xs);
    return fallback;
  }
  const pilot = silvermanBandwidth(xs);
  if (pilot <= 0) {
    warnings.push('pilot_bandwidth_zero');
    return fallback;
  }
  fallback.pilotBandwidth = pilot;

  const leftIdx: number[] = [];
  const rightIdx: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs(xs[i]! - cutoff) > pilot) continue;
    if (xs[i]! < cutoff) leftIdx.push(i);
    else rightIdx.push(i);
  }
  if (leftIdx.length < 3 || rightIdx.length < 3) {
    warnings.push('insufficient_obs_per_side_within_pilot');
    fallback.bandwidth = pilot;
    return fallback;
  }
  const xL = leftIdx.map((i) => xs[i]!);
  const yL = leftIdx.map((i) => ys[i]!);
  const xR = rightIdx.map((i) => xs[i]!);
  const yR = rightIdx.map((i) => ys[i]!);

  const sigma2L = localResidualVariance(xL, yL);
  const sigma2R = localResidualVariance(xR, yR);
  if (sigma2L == null || sigma2R == null) {
    warnings.push('residual_variance_estimate_failed');
    fallback.bandwidth = pilot;
    return fallback;
  }
  fallback.varianceLeft = sigma2L;
  fallback.varianceRight = sigma2R;

  const m2L = localQuadraticSecondDerivative(xL, yL, cutoff);
  const m2R = localQuadraticSecondDerivative(xR, yR, cutoff);
  if (m2L == null || m2R == null) {
    warnings.push('curvature_estimate_failed');
    fallback.bandwidth = pilot;
    return fallback;
  }
  const curvatureSq = (m2R - m2L) ** 2;
  fallback.curvatureSquared = curvatureSq;

  const f0 = densityAtCutoff(xs, cutoff, pilot);
  fallback.densityAtCutoff = f0;
  if (f0 <= 0 || curvatureSq <= 0) {
    warnings.push('zero_density_or_curvature');
    fallback.bandwidth = pilot;
    return fallback;
  }

  const sumSigma2 = sigma2L + sigma2R;
  const num = sumSigma2;
  const den = f0 * curvatureSq;
  const h = TRIANGULAR_KERNEL_CONST * Math.pow(num / den, 1 / 5) * Math.pow(xs.length, -1 / 5);

  if (!Number.isFinite(h) || h <= 0) {
    warnings.push('ik_bandwidth_invalid');
    fallback.bandwidth = pilot;
    return fallback;
  }

  return {
    bandwidth: h,
    method: 'imbens_kalyanaraman',
    pilotBandwidth: pilot,
    densityAtCutoff: f0,
    varianceLeft: sigma2L,
    varianceRight: sigma2R,
    curvatureSquared: curvatureSq,
    warnings,
  };
}

// Re-export so callers needing the canonical name can import from one place.
export { mean };
