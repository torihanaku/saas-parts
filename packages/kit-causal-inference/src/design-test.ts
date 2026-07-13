/**
 * Incrementality Test Design (Power Analysis) — calculates the required
 * sample size and duration for an experiment given a baseline rate and an
 * expected relative lift.
 *
 * Ported from 実運用SaaS `server/services/incrementalityDesignAgent.ts`
 * (numerics unchanged; already a pure function in the origin).
 */

export interface TestDesignInput {
  metric: 'conversion' | 'revenue';
  baseline: number;     // e.g. 0.02 for 2%
  expectedLift: number; // e.g. 0.10 for 10% relative lift
  alpha?: number;       // significance level, default 0.05
  power?: number;       // statistical power, default 0.8
  dailyTraffic?: number;// estimated daily users/views
}

export interface TestDesignOutput {
  sampleSizePerGroup: number;
  totalSampleSize: number;
  suggestedDurationDays: number;
  splitRatio: [number, number];
  warnings: string[];
}

export function designTest(input: TestDesignInput): TestDesignOutput {
  const alpha = input.alpha || 0.05;
  const power = input.power || 0.8;
  const baseline = input.baseline;
  const expectedLift = input.expectedLift;
  const dailyTraffic = input.dailyTraffic || 1000;

  const warnings: string[] = [];
  if (power > 0.95) {
    warnings.push('High power ( > 0.95) requires significantly larger sample sizes.');
  }

  // 1. Calculate required sample size for proportion (Conversion)
  // Formula: n = (Z_alpha/2 + Z_beta)^2 * [p1(1-p1) + p2(1-p2)] / (p1 - p2)^2

  // Z-scores (Approximations)
  const getZ = (p: number) => {
    if (p === 0.05) return 1.96; // two-tailed alpha=0.05
    if (p === 0.01) return 2.58;
    if (p === 0.80) return 0.84; // one-tailed for power
    if (p === 0.90) return 1.28;
    if (p === 0.95) return 1.64;
    if (p === 0.99) return 2.33;
    return 1.96; // default
  };

  const zAlpha = getZ(alpha);
  const zBeta = getZ(power);

  const p1 = baseline;
  const p2 = baseline * (1 + expectedLift);

  const numerator = Math.pow(zAlpha + zBeta, 2) * (p1 * (1 - p1) + p2 * (1 - p2));
  const denominator = Math.pow(p1 - p2, 2);

  const n = Math.ceil(numerator / denominator);

  // 2. Suggested duration
  const suggestedDuration = Math.ceil((n * 2) / dailyTraffic);

  return {
    sampleSizePerGroup: n,
    totalSampleSize: n * 2,
    suggestedDurationDays: suggestedDuration,
    splitRatio: [0.5, 0.5],
    warnings,
  };
}
