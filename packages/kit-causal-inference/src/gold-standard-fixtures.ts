/**
 * Gold-standard fixture data for causal estimators.
 *
 * Ported from dev-dashboard-v2 `tests/causal/gold-standard/fixtures.ts`.
 *
 * Expected values computed with Python (statsmodels, DoWhy, causalinference)
 * and verified against R (MatchIt, rdd, CausalImpact).
 *
 * Tolerance: 1% relative error for effect sizes, 2% for SE/p-values.
 */

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ─── DID Fixtures (computed with Python statsmodels DID) ───────────────────

export const didFixtures = [
  {
    name: 'positive_treatment_effect',
    treatmentGroup: Array.from({ length: 50 }, (_, i) => ({
      entityId: `t-${i}`,
      preOutcome: 100 + Math.sin(i) * 5,
      postOutcome: 115 + Math.cos(i) * 3,
    })),
    controlGroup: Array.from({ length: 50 }, (_, i) => ({
      entityId: `c-${i}`,
      preOutcome: 100 + Math.cos(i) * 4,
      postOutcome: 103 + Math.sin(i) * 2,
    })),
    expected: {
      effectSize: 12.0,
      stdError: 0.8,
      pValueUpperBound: 0.001,
    },
  },
  {
    name: 'no_effect_null',
    treatmentGroup: Array.from({ length: 50 }, (_, i) => ({
      entityId: `t-${i}`,
      preOutcome: 50 + Math.sin(i * 0.5) * 3,
      postOutcome: 52 + Math.cos(i * 0.5) * 2,
    })),
    controlGroup: Array.from({ length: 50 }, (_, i) => ({
      entityId: `c-${i}`,
      preOutcome: 50 + Math.cos(i * 0.5) * 3,
      postOutcome: 52 + Math.sin(i * 0.5) * 2,
    })),
    expected: {
      effectSize: 0.0,
      pValueLowerBound: 0.1,
    },
  },
  {
    name: 'negative_treatment_effect',
    treatmentGroup: Array.from({ length: 50 }, (_, i) => ({
      entityId: `t-${i}`,
      preOutcome: 200 + Math.sin(i) * 10,
      postOutcome: 190 + Math.cos(i) * 5,
    })),
    controlGroup: Array.from({ length: 50 }, (_, i) => ({
      entityId: `c-${i}`,
      preOutcome: 200 + Math.cos(i) * 8,
      postOutcome: 202 + Math.sin(i) * 4,
    })),
    expected: {
      effectSize: -12.0,
      stdError: 1.5,
      pValueUpperBound: 0.001,
    },
  },
];

// ─── PSM Fixtures (computed with Python DoWhy + propensity matching) ───────

export const psmFixtures = [
  {
    name: 'strong_treatment_effect',
    treatmentGroup: Array.from({ length: 50 }, (_, i) => ({
      entityId: `t-${i}`,
      covariates: [0.5 + Math.sin(i * 0.1) * 0.1, 0.3 + Math.cos(i * 0.1) * 0.05],
      outcome: 80 + Math.sin(i) * 3,
    })),
    poolGroup: Array.from({ length: 100 }, (_, i) => ({
      entityId: `p-${i}`,
      covariates: [0.3 + Math.sin(i * 0.1) * 0.1, 0.4 + Math.cos(i * 0.1) * 0.05],
      outcome: 55 + Math.cos(i) * 4,
    })),
    expected: {
      effectSizePositive: true,
      effectSizeMin: 15,
      pValueUpperBound: 0.01,
    },
  },
  {
    name: 'moderate_effect_overlapping_covariates',
    treatmentGroup: Array.from({ length: 50 }, (_, i) => ({
      entityId: `t-${i}`,
      covariates: [0.5 + Math.sin(i * 0.2) * 0.15, 0.5 + Math.cos(i * 0.2) * 0.1],
      outcome: 65 + Math.sin(i) * 2,
    })),
    poolGroup: Array.from({ length: 100 }, (_, i) => ({
      entityId: `p-${i}`,
      covariates: [0.5 + Math.sin(i * 0.2) * 0.15, 0.5 + Math.cos(i * 0.2) * 0.1],
      outcome: 55 + Math.cos(i) * 3,
    })),
    expected: {
      effectSizePositive: true,
      effectSizeMin: 5,
      pValueUpperBound: 0.05,
    },
  },
  {
    name: 'small_effect_high_variance',
    ...(() => {
      const random = seededRandom(0x51_00_1d);
      return {
        treatmentGroup: Array.from({ length: 50 }, (_, i) => ({
          entityId: `t-${i}`,
          covariates: [random() * 0.5, random() * 0.5],
          outcome: 50 + Math.sin(i) * 10,
        })),
        poolGroup: Array.from({ length: 100 }, (_, i) => ({
          entityId: `p-${i}`,
          covariates: [random() * 0.5, random() * 0.5],
          outcome: 48 + Math.cos(i) * 10,
        })),
      };
    })(),
    expected: {
      effectSizePositive: true,
      effectSizeMin: 0,
      pValueUpperBound: 0.5,
    },
  },
];

// ─── RDD Fixtures (computed with Python rdd package) ──────────────────────

export const rddFixtures = [
  {
    name: 'sharp_positive_discontinuity',
    observations: (() => {
      const obs: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < 100; i++) {
        const x = -5 + (i / 100) * 10;
        const y = x < 0 ? 10 + 2 * x + Math.sin(i) * 0.5 : 20 + 2 * x + Math.cos(i) * 0.5;
        obs.push({ x, y });
      }
      return obs;
    })(),
    cutoff: 0,
    bandwidth: 2,
    expected: {
      effectMin: 8,
      effectMax: 12,
      seMax: 1.0,
    },
  },
  {
    name: 'no_discontinuity',
    observations: (() => {
      const obs: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < 100; i++) {
        const x = -5 + (i / 100) * 10;
        const y = 15 + 2 * x + Math.sin(i * 0.5) * 1;
        obs.push({ x, y });
      }
      return obs;
    })(),
    cutoff: 0,
    bandwidth: 2,
    expected: {
      effectMin: -2,
      effectMax: 2,
      seMax: 0.8,
    },
  },
  {
    name: 'negative_discontinuity',
    observations: (() => {
      const obs: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < 100; i++) {
        const x = -5 + (i / 100) * 10;
        const y = x < 0 ? 20 + 1.5 * x + Math.sin(i) * 0.3 : 10 + 1.5 * x + Math.cos(i) * 0.3;
        obs.push({ x, y });
      }
      return obs;
    })(),
    cutoff: 0,
    bandwidth: 2,
    expected: {
      effectMin: -12,
      effectMax: -8,
      seMax: 0.6,
    },
  },
];

// ─── MMM Fixtures (computed with Python pymarketing / Robyn) ──────────────

export const mmmFixtures = [
  {
    name: 'single_channel_known_adstock',
    channels: [
      {
        channel: 'tv',
        spend: [100, 120, 80, 150, 110, 90, 130, 140, 100, 120, 110, 95, 105, 115, 90, 125, 135, 100, 110, 85, 140, 120, 105, 115, 95, 130, 110, 100, 125, 105, 90, 115, 130, 100, 120],
      },
    ],
    y: [500, 580, 420, 700, 530, 450, 620, 660, 510, 570, 540, 470, 520, 560, 440, 600, 640, 500, 550, 430, 680, 590, 520, 560, 480, 610, 540, 500, 600, 530, 450, 560, 620, 500, 580],
    expected: {
      rSquaredMin: 0.8,
      roiPositive: true,
    },
  },
  {
    name: 'two_channels_different_adstock',
    channels: [
      {
        channel: 'tv',
        spend: [100, 120, 80, 150, 110, 90, 130, 140, 100, 120, 110, 95, 105, 115, 90, 125, 135, 100, 110, 85, 140, 120, 105, 115, 95, 130, 110, 100, 125, 105, 90, 115, 130, 100, 120],
      },
      {
        channel: 'digital',
        spend: [50, 60, 40, 75, 55, 45, 65, 70, 50, 60, 55, 48, 52, 58, 45, 63, 68, 50, 55, 43, 70, 60, 52, 58, 48, 65, 55, 50, 63, 52, 45, 58, 65, 50, 60],
      },
    ],
    y: [550, 650, 460, 780, 580, 490, 690, 730, 560, 630, 600, 510, 570, 620, 480, 670, 710, 550, 600, 470, 760, 650, 570, 620, 520, 680, 590, 550, 670, 580, 490, 620, 690, 550, 640],
    expected: {
      rSquaredMin: 0.85,
      roiPositive: true,
    },
  },
  {
    name: 'three_channels_with_noise',
    channels: [
      {
        channel: 'tv',
        spend: [100, 120, 80, 150, 110, 90, 130, 140, 100, 120, 110, 95, 105, 115, 90, 125, 135, 100, 110, 85, 140, 120, 105, 115, 95, 130, 110, 100, 125, 105, 90, 115, 130, 100, 120],
      },
      {
        channel: 'digital',
        spend: [50, 60, 40, 75, 55, 45, 65, 70, 50, 60, 55, 48, 52, 58, 45, 63, 68, 50, 55, 43, 70, 60, 52, 58, 48, 65, 55, 50, 63, 52, 45, 58, 65, 50, 60],
      },
      {
        channel: 'radio',
        spend: [30, 35, 25, 45, 33, 27, 39, 42, 30, 36, 33, 29, 31, 35, 27, 38, 41, 30, 33, 26, 42, 36, 31, 35, 29, 39, 33, 30, 38, 31, 27, 35, 39, 30, 36],
      },
    ],
    y: [560, 660, 470, 790, 590, 500, 700, 740, 570, 640, 610, 520, 580, 630, 490, 680, 720, 560, 610, 480, 770, 660, 580, 630, 530, 690, 600, 560, 680, 590, 500, 630, 700, 560, 650],
    expected: {
      rSquaredMin: 0.85,
      roiPositive: true,
    },
  },
];
