/**
 * Monte Carlo simulation for scenario prediction (Twin #1360).
 *
 * Runs N (default 1000) trials of the simulator's prediction loop, perturbing
 * elasticities and baseline std by gaussian noise to derive an empirical
 * distribution of each output metric. Returns the 5th / 50th / 95th
 * percentiles + mean + std per output metric.
 *
 * Why monte carlo when the simulator already returns mean ± std bands?
 * Because the existing CI is computed as `mean ± z * baseline.std` — that
 * captures *baseline noise* but not *model uncertainty* (elasticity
 * coefficient uncertainty + cross-channel interactions). MC propagates both.
 *
 * Performance budget: 1000 trials × ~10 outputs × ~5 input keys = 50k mults
 * per call. < 50ms in practice on modern runtimes.
 *
 * Ported from 実運用SaaS server/lib/twin/monte-carlo.ts.
 * 変更点: `rng` を直接注入可能に（`seed` によるmulberry32生成は従来通りのデフォルト）。
 */

const DEFAULT_TRIALS = 1000;
const ELASTICITY_NOISE_SIGMA = 0.1; // 10% noise on coefficient (stand-in for posterior std)

export interface MonteCarloInput {
  /** baseline mean & std per metric. */
  baseline: Record<string, { mean: number; std: number }>;
  /** scenario inputs the user is pushing (key -> value). */
  scenarioInputs: Record<string, number>;
  /** elasticity table from elasticity-extractor (input -> output -> coef). */
  elasticities: Record<string, Record<string, number>>;
  /** Number of trials. Caller may override for tests. */
  trials?: number;
  /** RNG seed (deterministic). Defaults to a fixed value for repeatable tests. */
  seed?: number;
  /** Injectable RNG in [0,1). Takes precedence over `seed` when provided. */
  rng?: () => number;
}

export interface MonteCarloDistribution {
  mean: number;
  std: number;
  p5: number;
  p50: number;
  p95: number;
}

export type MonteCarloOutput = Record<string, MonteCarloDistribution>;

/**
 * Mulberry32 — small deterministic PRNG. Sufficient for monte carlo accuracy
 * at N=1000 and avoids depending on the platform's `Math.random` (which is
 * not seedable and would make tests flaky).
 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller standard-normal sampler. */
function sampleNormal(rng: () => number): number {
  // Avoid log(0) by clamping U1 away from 0.
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx]!;
}

export function runMonteCarlo(input: MonteCarloInput): MonteCarloOutput {
  const trials = Math.max(1, Math.min(input.trials ?? DEFAULT_TRIALS, 10_000));
  const rng = input.rng ?? makeRng(input.seed ?? 42);

  const outputKeys = Object.keys(input.baseline);
  // Pre-allocate sample buffers, one per output metric.
  const samples: Record<string, number[]> = {};
  for (const k of outputKeys) samples[k] = new Array<number>(trials);

  for (let t = 0; t < trials; t++) {
    for (const outKey of outputKeys) {
      const base = input.baseline[outKey]!;
      // Start each trial at a noisy baseline mean (captures baseline std).
      let predicted = base.mean + sampleNormal(rng) * base.std;

      // Apply scenario deltas, perturbing each elasticity by gaussian noise.
      for (const [inputKey, inputValue] of Object.entries(input.scenarioInputs)) {
        const e = input.elasticities[inputKey]?.[outKey] ?? 0;
        if (e === 0) continue;
        const inputBase = input.baseline[inputKey]?.mean ?? 1;
        const perturbedE = e * (1 + sampleNormal(rng) * ELASTICITY_NOISE_SIGMA);
        predicted += (inputValue - inputBase) * perturbedE;
      }

      samples[outKey]![t] = Math.max(0, predicted);
    }
  }

  const out: MonteCarloOutput = {};
  for (const k of outputKeys) {
    const arr = samples[k]!;
    const sorted = arr.slice().sort((a, b) => a - b);
    const sum = arr.reduce((s, v) => s + v, 0);
    const mean = sum / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) * (v - mean), 0) / arr.length;
    out[k] = {
      mean,
      std: Math.sqrt(variance),
      p5: quantile(sorted, 0.05),
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
    };
  }
  return out;
}

// Internal exports for testing only.
export const __testing = { makeRng, sampleNormal, quantile, DEFAULT_TRIALS };
