/**
 * Fuzzy Regression Discontinuity Design.
 *
 * Ported from 実運用SaaS `server/lib/causal/rdd/fuzzy.ts`.
 *
 * In Sharp RDD treatment is deterministic at the cutoff: P(D=1 | x≥c) = 1.
 * In real-world marketing experiments treatment is often "encouraged" rather
 * than enforced (e.g. coupon emails sent to users above a loyalty score
 * cutoff, but only some open the email and use the coupon). The treatment
 * probability jumps at c but does not go from 0→1 — that's a Fuzzy design.
 *
 * Identification (Hahn–Todd–Van der Klaauw 2001):
 *
 *           lim_{x↓c} E[y|x]  −  lim_{x↑c} E[y|x]
 *   τ_LATE = ─────────────────────────────────────
 *           lim_{x↓c} E[D|x]  −  lim_{x↑c} E[D|x]
 *
 * Numerator is the Sharp RDD estimate of y at the cutoff (reduced form).
 * Denominator is the same estimate applied to the treatment-take-up indicator
 * D (first stage). Their ratio is the Local Average Treatment Effect (LATE)
 * — equivalent to 2SLS with the threshold-cross indicator as the instrument.
 *
 * The compliance rate (= first-stage jump) tells us how strong the threshold
 * is as an instrument. If it's < 0.05 we surface a `weak_first_stage`
 * warning so the caller can either widen bandwidth or fall back to PSM.
 */

import {
  getZScore,
  linearRegression,
  mean,
  standardErrorAt,
  stdev,
  type LinearFit,
} from './stats.js';

export interface FuzzyRddObservation {
  x: number;        // running variable
  y: number;        // outcome
  /** Treatment-take-up indicator (0 or 1). For continuous treatment intensity
   *  the same code path works; we just compute mean rather than rate. */
  d: number;
}

export interface FuzzyRddInput {
  tenantId?: string;
  experimentId?: string;
  observations: FuzzyRddObservation[];
  cutoff: number;
  /** Optional bandwidth in units of x. If omitted, Silverman's rule is used. */
  bandwidth?: number;
  /** Default 0.95. */
  confidenceLevel?: number;
}

export interface FuzzyRddOutput {
  /** Local Average Treatment Effect at the cutoff. */
  effect: number | null;
  seEstimate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  /** First-stage jump in P(D=1) at the cutoff (compliance rate). */
  complianceRate: number | null;
  reducedFormJump: number | null;
  nLeft: number;
  nRight: number;
  bandwidth: number;
  bandwidthMethod: 'user' | 'silverman';
  method: 'fuzzy_rdd_2sls';
  assumptions: Array<{ name: string; satisfied: boolean; note?: string }>;
  warnings: string[];
}

const MIN_PER_SIDE = 5;
const WEAK_FIRST_STAGE_THRESHOLD = 0.05;

function silvermanBandwidth(xs: number[]): number {
  if (xs.length < 2) return 0;
  const sigma = stdev(xs);
  if (sigma === 0) return 0;
  return 1.06 * sigma * Math.pow(xs.length, -1 / 5);
}

function emptyOutput(
  bandwidth: number,
  bandwidthMethod: 'user' | 'silverman',
  nLeft: number,
  nRight: number,
  assumptions: FuzzyRddOutput['assumptions'],
  warnings: string[],
): FuzzyRddOutput {
  return {
    effect: null,
    seEstimate: null,
    ciLow: null,
    ciHigh: null,
    complianceRate: null,
    reducedFormJump: null,
    nLeft,
    nRight,
    bandwidth,
    bandwidthMethod,
    method: 'fuzzy_rdd_2sls',
    assumptions,
    warnings,
  };
}

function localJump(
  leftFit: LinearFit,
  rightFit: LinearFit,
  cutoff: number,
): { jump: number; se: number } {
  const yhatLeft = leftFit.intercept + leftFit.slope * cutoff;
  const yhatRight = rightFit.intercept + rightFit.slope * cutoff;
  const seLeft = standardErrorAt(leftFit, cutoff);
  const seRight = standardErrorAt(rightFit, cutoff);
  return {
    jump: yhatRight - yhatLeft,
    se: Math.sqrt(seLeft * seLeft + seRight * seRight),
  };
}

export async function runFuzzyRdd(input: FuzzyRddInput): Promise<FuzzyRddOutput> {
  const warnings: string[] = [];
  const assumptions: FuzzyRddOutput['assumptions'] = [];

  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new Error('runFuzzyRdd: observations must be a non-empty array');
  }
  if (!Number.isFinite(input.cutoff)) {
    throw new Error('runFuzzyRdd: cutoff must be a finite number');
  }
  if (input.bandwidth !== undefined && !(input.bandwidth > 0)) {
    throw new Error('runFuzzyRdd: bandwidth must be > 0 when provided');
  }

  for (const obs of input.observations) {
    if (
      !Number.isFinite(obs.x) ||
      !Number.isFinite(obs.y) ||
      !Number.isFinite(obs.d)
    ) {
      throw new Error('runFuzzyRdd: observations must contain finite x, y, d');
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
      throw new Error('runFuzzyRdd: unable to derive bandwidth (zero variance in x)');
    }
  }

  const left: FuzzyRddObservation[] = [];
  const right: FuzzyRddObservation[] = [];
  for (const obs of input.observations) {
    const dist = obs.x - cutoff;
    if (Math.abs(dist) > bandwidth) continue;
    if (dist < 0) left.push(obs);
    else right.push(obs);
  }

  const nLeft = left.length;
  const nRight = right.length;

  if (nLeft === 0 || nRight === 0) {
    throw new Error(
      `runFuzzyRdd: no observations within bandwidth on ${nLeft === 0 ? 'left' : 'right'} side of cutoff`,
    );
  }
  if (nLeft < MIN_PER_SIDE || nRight < MIN_PER_SIDE) {
    warnings.push('sample_size_small_per_side');
    assumptions.push({
      name: `min_${MIN_PER_SIDE}_per_side`,
      satisfied: false,
      note: `nLeft=${nLeft}, nRight=${nRight}`,
    });
    return emptyOutput(bandwidth, bandwidthMethod, nLeft, nRight, assumptions, warnings);
  }
  assumptions.push({ name: `min_${MIN_PER_SIDE}_per_side`, satisfied: true });

  // Reduced form: regress y on x within each side, take the jump at cutoff.
  let yLeftFit: LinearFit;
  let yRightFit: LinearFit;
  let dLeftFit: LinearFit;
  let dRightFit: LinearFit;
  try {
    yLeftFit = linearRegression(left.map((o) => o.x), left.map((o) => o.y));
    yRightFit = linearRegression(right.map((o) => o.x), right.map((o) => o.y));
    dLeftFit = linearRegression(left.map((o) => o.x), left.map((o) => o.d));
    dRightFit = linearRegression(right.map((o) => o.x), right.map((o) => o.d));
  } catch (err) {
    warnings.push('local_regression_failed');
    warnings.push(err instanceof Error ? err.message : 'unknown');
    return emptyOutput(bandwidth, bandwidthMethod, nLeft, nRight, assumptions, warnings);
  }

  const reduced = localJump(yLeftFit, yRightFit, cutoff);
  const firstStage = localJump(dLeftFit, dRightFit, cutoff);

  const compliance = firstStage.jump;

  // Guard against weak instrument: if treatment barely shifts at the cutoff,
  // dividing by it amplifies noise to absurd levels.
  if (Math.abs(compliance) < WEAK_FIRST_STAGE_THRESHOLD) {
    warnings.push('weak_first_stage');
    assumptions.push({
      name: 'first_stage_strength',
      satisfied: false,
      note: `compliance=${compliance.toFixed(4)} (need |Δ| ≥ ${WEAK_FIRST_STAGE_THRESHOLD})`,
    });
    return {
      ...emptyOutput(bandwidth, bandwidthMethod, nLeft, nRight, assumptions, warnings),
      complianceRate: compliance,
      reducedFormJump: reduced.jump,
    };
  }
  assumptions.push({ name: 'first_stage_strength', satisfied: true });

  // 2SLS / Wald estimator: τ_LATE = reduced form jump / first stage jump.
  const effect = reduced.jump / compliance;

  // Delta-method SE for the ratio (assumes independence of numerator/denominator
  // standard errors — slightly conservative but correct in the limit). See
  // Imbens & Lemieux 2008, eq. (10).
  const seEstimate =
    Math.abs(1 / compliance) *
    Math.sqrt(
      reduced.se ** 2 + (effect ** 2) * firstStage.se ** 2,
    );

  let z: number;
  try {
    z = getZScore(input.confidenceLevel ?? 0.95);
  } catch {
    warnings.push('invalid_confidence_level');
    z = 1.96;
  }
  const ciLow = effect - z * seEstimate;
  const ciHigh = effect + z * seEstimate;

  // Continuity assumption (same as Sharp RDD) — unverified statistical test
  // is out of scope; surface as an assumption banner.
  assumptions.push({
    name: 'continuity_at_cutoff',
    satisfied: false,
    note: 'assumed — verify with density (McCrary) and covariate-balance plots',
  });

  // Mean treatment intensity inside bandwidth (UI helper).
  const meanD = mean(input.observations.map((o) => o.d));
  if (meanD === 0 || meanD === 1) {
    warnings.push('treatment_take_up_degenerate');
  }

  return {
    effect,
    seEstimate,
    ciLow,
    ciHigh,
    complianceRate: compliance,
    reducedFormJump: reduced.jump,
    nLeft,
    nRight,
    bandwidth,
    bandwidthMethod,
    method: 'fuzzy_rdd_2sls',
    assumptions,
    warnings,
  };
}
