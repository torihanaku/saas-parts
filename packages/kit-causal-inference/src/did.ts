/**
 * Difference-in-Differences (DID).
 *
 * Ported from dev-dashboard-v2 `server/lib/causal/did-service.ts`.
 * Changes vs. origin: `tenantId` / `experimentId` are now optional metadata
 * (the kit does not require product identifiers). Statistics unchanged.
 */

import { mean, variance, getZScore, normalCdf } from './stats.js';

export interface DidInput {
  tenantId?: string;
  experimentId?: string;
  treatmentGroup: Array<{ entityId: string; preOutcome: number; postOutcome: number }>;
  controlGroup: Array<{ entityId: string; preOutcome: number; postOutcome: number }>;
  confidenceLevel?: number;  // default 0.95
}

export interface DidOutput {
  effectSize: number | null;
  stdError: number | null;
  pValue: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  sampleSize: { treatment: number; control: number };
  assumptions: Array<{ name: string; satisfied: boolean; note?: string }>;
  warnings: string[];
}

export async function runDid(input: DidInput): Promise<DidOutput> {
  const nT = input.treatmentGroup.length;
  const nC = input.controlGroup.length;

  const warnings: string[] = [];
  const assumptions: Array<{ name: string; satisfied: boolean; note?: string }> = [];
  if (nT < 30 || nC < 30) {
    warnings.push('sample_size_small');
    assumptions.push({ name: 'sample_size_min_30', satisfied: false, note: `nT=${nT}, nC=${nC}` });
    return {
      effectSize: null, stdError: null, pValue: null, ciLower: null, ciUpper: null,
      sampleSize: { treatment: nT, control: nC },
      assumptions, warnings,
    };
  }
  assumptions.push({ name: 'sample_size_min_30', satisfied: true });

  const tPre = mean(input.treatmentGroup.map(x => x.preOutcome));
  const tPost = mean(input.treatmentGroup.map(x => x.postOutcome));
  const cPre = mean(input.controlGroup.map(x => x.preOutcome));
  const cPost = mean(input.controlGroup.map(x => x.postOutcome));
  const did = (tPost - tPre) - (cPost - cPre);

  const varT = variance(input.treatmentGroup.map(x => x.postOutcome - x.preOutcome));
  const varC = variance(input.controlGroup.map(x => x.postOutcome - x.preOutcome));
  const se = Math.sqrt(varT / nT + varC / nC);

  let z: number;
  try {
    z = getZScore(input.confidenceLevel);
  } catch (_error) {
    warnings.push('invalid_confidence_level');
    return {
      effectSize: null, stdError: null, pValue: null, ciLower: null, ciUpper: null,
      sampleSize: { treatment: nT, control: nC },
      assumptions, warnings,
    };
  }

  const ciLower = did - z * se;
  const ciUpper = did + z * se;

  const zStat = Math.abs(did / se);
  const pValue = 2 * (1 - normalCdf(zStat));

  assumptions.push({
    name: 'parallel_trends',
    satisfied: false,
    note: 'assumed — verify by plotting pre-period outcomes',
  });

  return {
    effectSize: did,
    stdError: se,
    pValue,
    ciLower,
    ciUpper,
    sampleSize: { treatment: nT, control: nC },
    assumptions, warnings,
  };
}
