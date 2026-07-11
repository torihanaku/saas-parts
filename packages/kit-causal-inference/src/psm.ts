/**
 * Propensity Score Matching (PSM).
 *
 * Logistic regression (gradient descent, early stopping) → propensity scores
 * → greedy 1:1 nearest-neighbour matching with caliper → ATT ± CI.
 *
 * Ported from dev-dashboard-v2 `server/lib/causal/psm-service.ts`.
 * Changes vs. origin: `tenantId` / `experimentId` optional. Statistics unchanged.
 */

import { mean, variance, getZScore, normalCdf } from './stats.js';

export interface PsmInput {
  tenantId?: string;
  experimentId?: string;
  treatmentGroup: Array<{ entityId: string; covariates: number[]; outcome: number }>;
  poolGroup: Array<{ entityId: string; covariates: number[]; outcome: number }>;
  confidenceLevel?: number;  // default 0.95
}

export interface PsmOutput {
  effectSize: number | null;
  stdError: number | null;
  pValue: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  sampleSize: { treatment: number; control: number };
  assumptions: Array<{ name: string; satisfied: boolean; note?: string }>;
  warnings: string[];
}

const DEFAULT_CALIPER = 0.2;

function logisticRegression(X: number[][], y: number[], learningRate = 0.1, epochs = 1000): number[] {
  const numFeatures = X[0]!.length;
  let weights: number[] = new Array(numFeatures).fill(0);
  const tolerance = 1e-5;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradients: number[] = new Array(numFeatures).fill(0);
    for (let i = 0; i < X.length; i++) {
      const z = weights.reduce((sum, w, j) => sum + w * X[i]![j]!, 0);
      const prediction = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
      const error = prediction - y[i]!;
      for (let j = 0; j < numFeatures; j++) {
        gradients[j]! += error * X[i]![j]!;
      }
    }

    let maxGrad = 0;
    weights = weights.map((w, j) => {
      const gradStep = learningRate * (gradients[j]! / X.length);
      maxGrad = Math.max(maxGrad, Math.abs(gradStep));
      return w - gradStep;
    });

    if (maxGrad < tolerance) {
      break; // early stopping
    }
  }
  return weights;
}

function calculatePropensityScore(x: number[], weights: number[]): number {
  const z = weights.reduce((sum, w, j) => sum + w * x[j]!, 0);
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

export async function runPsm(input: PsmInput): Promise<PsmOutput> {
  const nT = input.treatmentGroup.length;
  const warnings: string[] = [];
  const assumptions: Array<{ name: string; satisfied: boolean; note?: string }> = [];

  if (nT < 30 || input.poolGroup.length < nT) {
    warnings.push('insufficient_pool_size');
    assumptions.push({ name: 'sufficient_matching_pool', satisfied: false, note: `nT=${nT}, pool=${input.poolGroup.length}` });
    return {
      effectSize: null, stdError: null, pValue: null, ciLower: null, ciUpper: null,
      sampleSize: { treatment: nT, control: 0 },
      assumptions, warnings,
    };
  }

  const X_treat = input.treatmentGroup.map(item => [1, ...item.covariates]);
  const X_pool = input.poolGroup.map(item => [1, ...item.covariates]);

  const X = [...X_treat, ...X_pool];
  const y = [...new Array(nT).fill(1), ...new Array(input.poolGroup.length).fill(0)];

  const weights = logisticRegression(X, y);

  const treatmentScores = X_treat.map(x => calculatePropensityScore(x, weights));
  const poolScores = X_pool.map((x, i) => ({
    score: calculatePropensityScore(x, weights),
    outcome: input.poolGroup[i]!.outcome
  }));

  const matchedControls: number[] = [];
  const usedPoolIndices = new Set<number>();
  let matchQualityWarning = false;

  for (let i = 0; i < nT; i++) {
    const tScore = treatmentScores[i]!;
    let bestDist = Infinity;
    let bestIdx = -1;

    for (let j = 0; j < poolScores.length; j++) {
      if (usedPoolIndices.has(j)) continue;
      const dist = Math.abs(tScore - poolScores[j]!.score);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = j;
      }
    }

    if (bestIdx !== -1) {
      if (bestDist > DEFAULT_CALIPER) matchQualityWarning = true;
      matchedControls.push(poolScores[bestIdx]!.outcome);
      usedPoolIndices.add(bestIdx);
    }
  }

  if (matchedControls.length < nT) {
    warnings.push('not_all_treated_matched');
  }
  if (matchQualityWarning) {
    warnings.push('poor_match_quality_caliper_exceeded');
  }

  const nC = matchedControls.length;
  if (nC < 30) {
    assumptions.push({ name: 'sufficient_matches', satisfied: false });
    return {
      effectSize: null, stdError: null, pValue: null, ciLower: null, ciUpper: null,
      sampleSize: { treatment: nT, control: nC },
      assumptions, warnings,
    };
  }
  assumptions.push({ name: 'sufficient_matches', satisfied: true });

  const tMean = mean(input.treatmentGroup.map(x => x.outcome));
  const cMean = mean(matchedControls);
  const att = tMean - cMean;

  const varT = variance(input.treatmentGroup.map(x => x.outcome));
  const varC = variance(matchedControls);
  const se = Math.sqrt(varT / nT + varC / nC);

  let z: number;
  try {
    z = getZScore(input.confidenceLevel || 0.95);
  } catch (_error) {
    warnings.push('invalid_confidence_level');
    return {
      effectSize: null, stdError: null, pValue: null, ciLower: null, ciUpper: null,
      sampleSize: { treatment: nT, control: nC },
      assumptions, warnings,
    };
  }

  const ciLower = att - z * se;
  const ciUpper = att + z * se;

  const zStat = Math.abs(att / se);
  const pValue = 2 * (1 - normalCdf(zStat));

  return {
    effectSize: att,
    stdError: se,
    pValue,
    ciLower,
    ciUpper,
    sampleSize: { treatment: nT, control: nC },
    assumptions, warnings,
  };
}
