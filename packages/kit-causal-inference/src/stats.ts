/**
 * Shared statistical primitives for the causal-inference kit.
 *
 * Ported from dev-dashboard-v2 `server/lib/causal/stats-utils.ts`
 * (byte-equivalent numerics).
 */

export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function variance(arr: number[]): number {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  return arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
}

export function stdev(arr: number[]): number {
  return Math.sqrt(variance(arr));
}

export function getZScore(confidenceLevel: number = 0.95): number {
  if (confidenceLevel === 0.99) return 2.576;
  if (confidenceLevel === 0.95) return 1.96;
  if (confidenceLevel === 0.90) return 1.645;
  throw new Error(`Unsupported confidence level: ${confidenceLevel}`);
}

export function normalCdf(z: number): number {
  const absZ = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * absZ);
  const d = 0.3989423 * Math.exp(-absZ * absZ / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  const cdf = 1 - p;
  return z >= 0 ? cdf : 1 - cdf;
}

export interface LinearFit {
  intercept: number;
  slope: number;
  residualVariance: number;
  meanX: number;
  sumXSquared: number;
  n: number;
}

/**
 * OLS linear regression: y = intercept + slope * x.
 * Returns coefficients plus residual variance and the regressors needed for
 * standard-error computation at an arbitrary x (e.g. the RDD cutoff).
 *
 * Throws when n < 2 or when all x values are equal (variance = 0 → singular).
 */
export function linearRegression(xs: number[], ys: number[]): LinearFit {
  if (xs.length !== ys.length) {
    throw new Error('linearRegression: xs/ys length mismatch');
  }
  const n = xs.length;
  if (n < 2) {
    throw new Error('linearRegression: need at least 2 observations');
  }
  const meanX = mean(xs);
  const meanY = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - meanY);
  }
  if (sxx === 0) {
    throw new Error('linearRegression: zero variance in x (collinear)');
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const yhat = intercept + slope * xs[i]!;
    const r = ys[i]! - yhat;
    rss += r * r;
  }
  const residualVariance = n > 2 ? rss / (n - 2) : 0;
  return { intercept, slope, residualVariance, meanX, sumXSquared: sxx, n };
}

/**
 * Standard error of the predicted mean response at a given x:
 *   SE(ŷ_x) = sqrt(σ² · (1/n + (x - x̄)² / Σ(x_i - x̄)²))
 * where σ² is the residual variance from OLS.
 */
export function standardErrorAt(fit: LinearFit, x: number): number {
  if (fit.n <= 2 || fit.sumXSquared === 0) return 0;
  const dx = x - fit.meanX;
  const variance = fit.residualVariance * (1 / fit.n + (dx * dx) / fit.sumXSquared);
  return Math.sqrt(Math.max(variance, 0));
}
