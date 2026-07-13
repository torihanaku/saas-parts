/**
 * Sharp Regression Discontinuity Design (RDD).
 *
 * Ported from 実運用SaaS `server/lib/causal/rdd-service.ts`.
 * Statistics unchanged; `tenantId` / `experimentId` remain optional metadata.
 */

import {
  getZScore,
  linearRegression,
  standardErrorAt,
  stdev,
  type LinearFit,
} from './stats.js';

export interface RddObservation {
  x: number;        // running variable (assignment score)
  y: number;        // outcome
}

export interface RddInput {
  tenantId?: string;
  experimentId?: string;
  observations: RddObservation[];
  cutoff: number;
  /** Optional: bandwidth in units of x. If omitted, Silverman's rule is used. */
  bandwidth?: number;
  /** Default 0.95. */
  confidenceLevel?: number;
}

export interface RddOutput {
  effect: number | null;
  seEstimate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  nLeft: number;
  nRight: number;
  bandwidth: number;
  bandwidthMethod: 'user' | 'silverman';
  method: 'sharp_rdd';
  assumptions: Array<{ name: string; satisfied: boolean; note?: string }>;
  warnings: string[];
}

const MIN_PER_SIDE = 5;

/**
 * Silverman's rule of thumb for bandwidth on the running variable.
 *
 *   h = 1.06 · σ_x · n^(-1/5)
 *
 * Used as a pragmatic default when no bandwidth is supplied. This is a
 * rule-of-thumb (NOT Imbens–Kalyanaraman optimal); use
 * `imbensKalyanaramanBandwidth` from `rdd-bandwidth.ts` when you want the
 * MSE-optimal choice.
 */
export function silvermanBandwidth(xs: number[]): number {
  if (xs.length < 2) return 0;
  const sigma = stdev(xs);
  if (sigma === 0) return 0;
  return 1.06 * sigma * Math.pow(xs.length, -1 / 5);
}

/**
 * Sharp Regression Discontinuity Design.
 *
 * Treatment is deterministic at `cutoff`: units with x ≥ cutoff are treated.
 * The local average treatment effect at the cutoff is estimated by fitting two
 * separate linear regressions on observations within `bandwidth` of the cutoff
 * (one on each side), then taking the difference of their predicted means at
 * x = cutoff.
 *
 *   τ̂ = ŷ_right(c) − ŷ_left(c)
 *
 * Standard error is computed from the OLS residual variances on each side and
 * combined assuming independence:
 *
 *   SE(τ̂) = sqrt(SE_left(c)² + SE_right(c)²)
 */
export async function runRdd(input: RddInput): Promise<RddOutput> {
  const warnings: string[] = [];
  const assumptions: Array<{ name: string; satisfied: boolean; note?: string }> = [];

  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new Error('runRdd: observations must be a non-empty array');
  }
  if (!Number.isFinite(input.cutoff)) {
    throw new Error('runRdd: cutoff must be a finite number');
  }
  if (input.bandwidth !== undefined && !(input.bandwidth > 0)) {
    throw new Error('runRdd: bandwidth must be > 0 when provided');
  }

  // Validate observation shape – defensive against runtime callers.
  for (const obs of input.observations) {
    if (!Number.isFinite(obs.x) || !Number.isFinite(obs.y)) {
      throw new Error('runRdd: observations must contain finite x and y');
    }
  }

  const cutoff = input.cutoff;
  const allX = input.observations.map((o) => o.x);

  let bandwidth: number;
  let bandwidthMethod: 'user' | 'silverman';
  if (input.bandwidth !== undefined) {
    bandwidth = input.bandwidth;
    bandwidthMethod = 'user';
  } else {
    bandwidth = silvermanBandwidth(allX);
    bandwidthMethod = 'silverman';
    if (bandwidth <= 0) {
      throw new Error('runRdd: unable to derive bandwidth from data (zero variance in x)');
    }
  }

  const left: RddObservation[] = [];
  const right: RddObservation[] = [];
  for (const obs of input.observations) {
    const dist = obs.x - cutoff;
    if (Math.abs(dist) > bandwidth) continue;
    if (dist < 0) left.push(obs);
    else right.push(obs);  // dist >= 0 → treated side (sharp design)
  }

  const nLeft = left.length;
  const nRight = right.length;

  if (nLeft === 0 || nRight === 0) {
    throw new Error(
      `runRdd: no observations within bandwidth on ${nLeft === 0 ? 'left' : 'right'} side of cutoff`,
    );
  }

  if (nLeft < MIN_PER_SIDE || nRight < MIN_PER_SIDE) {
    warnings.push('sample_size_small_per_side');
    assumptions.push({
      name: `min_${MIN_PER_SIDE}_per_side`,
      satisfied: false,
      note: `nLeft=${nLeft}, nRight=${nRight}`,
    });
    return {
      effect: null,
      seEstimate: null,
      ciLow: null,
      ciHigh: null,
      nLeft,
      nRight,
      bandwidth,
      bandwidthMethod,
      method: 'sharp_rdd',
      assumptions,
      warnings,
    };
  }
  assumptions.push({ name: `min_${MIN_PER_SIDE}_per_side`, satisfied: true });

  let leftFit: LinearFit;
  let rightFit: LinearFit;
  try {
    leftFit = linearRegression(left.map((o) => o.x), left.map((o) => o.y));
    rightFit = linearRegression(right.map((o) => o.x), right.map((o) => o.y));
  } catch (err) {
    warnings.push('local_regression_failed');
    return {
      effect: null,
      seEstimate: null,
      ciLow: null,
      ciHigh: null,
      nLeft,
      nRight,
      bandwidth,
      bandwidthMethod,
      method: 'sharp_rdd',
      assumptions,
      warnings: [...warnings, err instanceof Error ? err.message : 'unknown'],
    };
  }

  const yhatLeft = leftFit.intercept + leftFit.slope * cutoff;
  const yhatRight = rightFit.intercept + rightFit.slope * cutoff;
  const effect = yhatRight - yhatLeft;

  const seLeft = standardErrorAt(leftFit, cutoff);
  const seRight = standardErrorAt(rightFit, cutoff);
  const seEstimate = Math.sqrt(seLeft * seLeft + seRight * seRight);

  let z: number;
  try {
    z = getZScore(input.confidenceLevel ?? 0.95);
  } catch {
    warnings.push('invalid_confidence_level');
    z = 1.96;
  }
  const ciLow = effect - z * seEstimate;
  const ciHigh = effect + z * seEstimate;

  // Sharp RDD identifying assumption is continuity of potential outcomes at the
  // cutoff. We can't test it numerically without smoothness diagnostics, so we
  // surface it as an unverified assumption (mirrors did.ts's pattern).
  assumptions.push({
    name: 'continuity_at_cutoff',
    satisfied: false,
    note: 'assumed — verify with density (McCrary) and covariate-balance plots',
  });

  return {
    effect,
    seEstimate,
    ciLow,
    ciHigh,
    nLeft,
    nRight,
    bandwidth,
    bandwidthMethod,
    method: 'sharp_rdd',
    assumptions,
    warnings,
  };
}
