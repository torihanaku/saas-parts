/**
 * Geometric adstock transformation for media-mix modelling.
 *
 * Ported from dev-dashboard-v2 `server/lib/causal/mmm/adstock.ts`.
 *
 *   x'_t = x_t + λ · x'_{t-1},   0 ≤ λ < 1
 *
 * The carry-over rate λ models the diminishing media memory: a TV burst this
 * week still has some effect next week. We use the simple geometric form
 * (Nerlove–Arrow) because it has one parameter per channel and survives the
 * grid + MH sampler in `mmm-bayesian-fit.ts` without identifiability issues.
 *
 * Choosing geometric over Weibull adstock here is a deliberate scope choice —
 * the saturation layer (`mmm-saturation.ts`) is where Hill/Weibull is
 * selected by the caller. Adstock and saturation are independent dials.
 */
export function geometricAdstock(spend: number[], lambda: number): number[] {
  if (lambda < 0 || lambda >= 1 || !Number.isFinite(lambda)) {
    throw new Error(`geometricAdstock: lambda must be in [0, 1), got ${lambda}`);
  }
  if (!Array.isArray(spend) || spend.length === 0) return [];
  const out = new Array<number>(spend.length);
  let prev = 0;
  for (let t = 0; t < spend.length; t++) {
    const v = spend[t]!;
    if (!Number.isFinite(v)) {
      throw new Error(`geometricAdstock: spend[${t}] is not finite`);
    }
    const cur = v + lambda * prev;
    out[t] = cur;
    prev = cur;
  }
  return out;
}

/**
 * Effective duration (in periods) at which the adstock contribution decays
 * to the supplied threshold. Useful for UI explanations: "this channel's
 * effect lasts ~N weeks".
 *
 * Solves λ^N = threshold for N → N = log(threshold) / log(λ).
 */
export function adstockEffectiveDuration(lambda: number, threshold = 0.05): number {
  if (lambda <= 0) return 0;
  if (lambda >= 1) return Number.POSITIVE_INFINITY;
  if (threshold <= 0 || threshold >= 1) {
    throw new Error(`adstockEffectiveDuration: threshold must be in (0, 1)`);
  }
  return Math.log(threshold) / Math.log(lambda);
}

/**
 * Bounded grid of plausible adstock rates for the prior. Kept small (11
 * points) so the outer MH sampler stays fast on typical 1–2 year daily
 * series (≤730 obs × ≤8 channels).
 */
export const ADSTOCK_GRID: readonly number[] = [
  0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9,
] as const;
