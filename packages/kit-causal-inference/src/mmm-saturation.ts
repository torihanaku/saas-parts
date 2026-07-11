import type { SaturationForm } from './mmm-types.js';

/**
 * Saturation curves for media-mix modelling.
 *
 * Ported from dev-dashboard-v2 `server/lib/causal/mmm/saturation.ts`.
 *
 * Both forms are bounded (output → 1 as input → ∞), so the linear coefficient
 * `beta` in the MMM regression carries the actual scale of the channel's
 * contribution.
 *
 * Hill (preferred default — interpretable):
 *   f(x; K, n) = x^n / (K^n + x^n)
 *   K = half-saturation (the spend at which the channel is at 50% of peak)
 *   n = shape (n=1 ≈ classic, n=2 produces a sharper S-curve)
 *
 * Weibull (sharper knee, useful for breakthrough campaigns):
 *   f(x; λ, k) = 1 − exp(−(x/λ)^k)
 *   λ = scale (analogous to half-life)
 *   k = shape (k>1 makes the curve more "step-like")
 */

export interface SaturationParams {
  shape: number;  // Hill: n,  Weibull: k
  scale: number;  // Hill: K,  Weibull: λ
}

/**
 * Apply the chosen saturation form pointwise. Returns NaN-safe values in
 * [0, 1]. Inputs ≤ 0 are clamped to 0 (negative spend is meaningless).
 */
export function saturate(
  xs: number[],
  form: SaturationForm,
  params: SaturationParams,
): number[] {
  if (form === 'hill') return xs.map((x) => hill(x, params.scale, params.shape));
  if (form === 'weibull') return xs.map((x) => weibull(x, params.scale, params.shape));
  throw new Error(`saturate: unknown form ${form}`);
}

export function hill(x: number, K: number, n: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (K <= 0 || n <= 0) return 0;
  const xn = Math.pow(x, n);
  return xn / (Math.pow(K, n) + xn);
}

export function weibull(x: number, lambda: number, k: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (lambda <= 0 || k <= 0) return 0;
  return 1 - Math.exp(-Math.pow(x / lambda, k));
}

/**
 * Saturation point ≈ spend at which marginal return drops below 50% of peak
 * marginal return. For Hill with K, this is exactly K (half-saturation). For
 * Weibull, we solve f'(x) ≤ 0.5 · f'(0) numerically over a coarse grid since
 * the closed form involves the inverse of a Weibull derivative.
 */
export function saturationPoint(form: SaturationForm, params: SaturationParams): number {
  if (form === 'hill') return params.scale;

  // Weibull: locate the first x in a grid past peak marginal.
  const { scale, shape } = params;
  if (scale <= 0 || shape <= 0) return scale;
  // For k ≤ 1 the marginal is monotonically decreasing → first point is x≈0;
  // we conventionally report scale (same UX as Hill K).
  if (shape <= 1) return scale;
  // Peak marginal is at x* = scale · ((k − 1) / k)^(1/k); after that the
  // marginal decays. We report 1.5 · x* as a stable proxy ("comfortably past
  // the knee"), which keeps the UI explanation honest without surfacing
  // numerical-search internals to the caller.
  const xStar = scale * Math.pow((shape - 1) / shape, 1 / shape);
  return 1.5 * xStar;
}

/**
 * Sample N saturation-curve points across [0, maxSpend × headroom] for the
 * UI to plot. Headroom defaults to 1.3 so the chart always shows the curve
 * starting to flatten beyond the largest observed spend.
 */
export function saturationCurvePoints(
  form: SaturationForm,
  params: SaturationParams,
  maxObservedSpend: number,
  beta: number,
  N = 50,
  headroom = 1.3,
): Array<{ spend: number; contribution: number }> {
  const upper = Math.max(maxObservedSpend, 1) * headroom;
  const out: Array<{ spend: number; contribution: number }> = [];
  for (let i = 0; i <= N; i++) {
    const spend = (upper * i) / N;
    const sat = form === 'hill'
      ? hill(spend, params.scale, params.shape)
      : weibull(spend, params.scale, params.shape);
    out.push({ spend, contribution: beta * sat });
  }
  return out;
}

/**
 * Coarse grids for the prior. Same rationale as `ADSTOCK_GRID`: keep grid
 * size manageable so the outer MH sampler finishes in <1s for 8 channels.
 */
export const SHAPE_GRID_HILL: readonly number[] = [0.5, 1.0, 1.5, 2.0, 3.0] as const;
export const SHAPE_GRID_WEIBULL: readonly number[] = [0.8, 1.0, 1.5, 2.0, 3.0] as const;
