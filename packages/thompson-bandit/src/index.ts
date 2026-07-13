/**
 * @torihanaku/thompson-bandit — A/BテストのためのThompsonサンプリング（純粋バンディット数学）
 *
 * Beta事後分布からのサンプリングでバリアントを確率的に割当てる。
 * 乱数は全関数で注入可能（`rand: () => number`、デフォルト Math.random）。
 * テストではシード付きPRNGを渡せば完全決定的になる。
 *
 * Ported from 実運用SaaS server/lib/ab-testing-bandit.ts (#362).
 * 変更点: shared/types からの AllocationResult import をローカル定義にインライン化。
 */

/** 割当結果。source は割当アルゴリズムの由来を示す。 */
export interface AllocationResult {
  variantId: string;
  source: "thompson" | "epsilon_greedy" | "ucb" | "fixed" | "fallback";
  /** Probability mass assigned to the chosen variant at decision time. */
  probability: number;
}

/** Beta事後を持つバリアント（alpha=成功+1, beta=失敗+1 が典型）。 */
export interface BetaVariant {
  id: string;
  alpha: number;
  beta: number;
}

const POSTERIOR_SAMPLE_DRAWS = 2000;

function standardNormal(rand: () => number): number {
  // Box-Muller. u1 floored to avoid log(0).
  const u1 = Math.max(rand(), Number.MIN_VALUE);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleGamma(shape: number, rand: () => number): number {
  // Marsaglia & Tsang (2000) for shape >= 1; boost shape<1 via the trick.
  if (shape < 1) {
    const u = rand();
    return sampleGamma(shape + 1, rand) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Sample once from Beta(alpha, beta) via two Gamma draws. */
export function sampleBeta(alpha: number, beta: number, rand: () => number = Math.random): number {
  if (alpha <= 0 || beta <= 0) throw new Error("alpha/beta must be > 0");
  const a = sampleGamma(alpha, rand);
  const b = sampleGamma(beta, rand);
  return a / (a + b);
}

/** Pick the variant with the highest sampled posterior. */
export function thompsonAllocate(
  variants: BetaVariant[],
  rand: () => number = Math.random,
): AllocationResult {
  if (variants.length === 0) throw new Error("no variants");
  let bestId = variants[0]!.id;
  let bestSample = -Infinity;
  for (const v of variants) {
    const s = sampleBeta(v.alpha, v.beta, rand);
    if (s > bestSample) {
      bestSample = s;
      bestId = v.id;
    }
  }
  return { variantId: bestId, source: "thompson", probability: bestSample };
}

/** Posterior probability that `targetId` has the highest mean among variants. */
export function posteriorBestProbability(
  variants: BetaVariant[],
  targetId: string,
  draws: number = POSTERIOR_SAMPLE_DRAWS,
  rand: () => number = Math.random,
): number {
  if (variants.length < 2) return variants[0]?.id === targetId ? 1 : 0;
  let wins = 0;
  for (let i = 0; i < draws; i++) {
    let bestId = variants[0]!.id;
    let bestSample = -Infinity;
    for (const v of variants) {
      const s = sampleBeta(v.alpha, v.beta, rand);
      if (s > bestSample) {
        bestSample = s;
        bestId = v.id;
      }
    }
    if (bestId === targetId) wins++;
  }
  return wins / draws;
}

/** Uniform allocator used for epsilon-greedy / fallback. */
export function uniformAllocate(
  variants: { id: string }[],
  rand: () => number = Math.random,
): AllocationResult {
  if (variants.length === 0) throw new Error("no variants");
  const idx = Math.floor(rand() * variants.length);
  return { variantId: variants[idx]!.id, source: "epsilon_greedy", probability: 1 / variants.length };
}

export const BANDIT_DEFAULTS = Object.freeze({
  POSTERIOR_DRAWS: POSTERIOR_SAMPLE_DRAWS,
});
