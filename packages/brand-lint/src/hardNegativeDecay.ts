/**
 * Hard Negative の重み減衰。
 *
 * 古い却下は新しい却下より軽く扱う — ブランドガイドラインや法令解釈は
 * 時代変化するため、5 年前 NG が今 OK になり得る。read-time に計算する
 * 純粋関数なので、定期的な減衰ジョブや DB マイグレーションは不要。
 *
 * カーブ:
 *   - 0 日   → 重み 1.0
 *   - 30 日  → 重み 0.5  （半減期）
 *   - 90 日  → 重み ≈ 0.125
 *   - 180 日 → 重み ≈ 0.016（実質ゼロ）
 *   - >180 日 → 0（isStillRelevant で除外）
 */

export const DECAY_HALF_LIFE_DAYS = 30;
export const HARD_CUTOFF_DAYS = 180;
export const DEFAULT_RELEVANCE_THRESHOLD = 0.1;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * `daysOld` 日前に観測された hard negative の減衰重み [0, 1]。
 * 負の年齢は 1.0 にクランプ（未来のタイムスタンプは「今」扱い）。
 * HARD_CUTOFF_DAYS 以上は 0。
 */
export function decayWeight(daysOld: number): number {
  if (!Number.isFinite(daysOld)) return 0;
  if (daysOld <= 0) return 1.0;
  if (daysOld >= HARD_CUTOFF_DAYS) return 0;
  return Math.pow(0.5, daysOld / DECAY_HALF_LIFE_DAYS);
}

/** 重みがしきい値以上なら「まだ有効」。 */
export function isStillRelevant(
  daysOld: number,
  threshold: number = DEFAULT_RELEVANCE_THRESHOLD,
): boolean {
  return decayWeight(daysOld) >= threshold;
}

/** `created_at`（ISO）と `now`（ms epoch, 既定は現在）の日数差。 */
export function daysSince(createdAtIso: string, now: number = Date.now()): number {
  const t = Date.parse(createdAtIso);
  if (Number.isNaN(t)) return Infinity; // パース不能 → 太古扱い
  return Math.max(0, (now - t) / MS_PER_DAY);
}

export interface HardNegativeSample {
  id: string;
  created_at: string;
}

export interface WeightedSample<T extends HardNegativeSample> {
  sample: T;
  daysOld: number;
  weight: number;
}

/** 各サンプルに減衰重みを付与（入力順を保持）。 */
export function weightSamples<T extends HardNegativeSample>(
  samples: T[],
  now: number = Date.now(),
): WeightedSample<T>[] {
  return samples.map((sample) => {
    const daysOld = daysSince(sample.created_at, now);
    return { sample, daysOld, weight: decayWeight(daysOld) };
  });
}

/**
 * しきい値未満を除外し、（任意で）重み上位 K 件を残す。
 * アンラップしたサンプルを新しい順で返す。
 */
export function selectRelevantSamples<T extends HardNegativeSample>(
  samples: T[],
  options: {
    now?: number;
    threshold?: number;
    topK?: number;
  } = {},
): T[] {
  const { now = Date.now(), threshold = DEFAULT_RELEVANCE_THRESHOLD, topK } = options;
  const weighted = weightSamples(samples, now)
    .filter((w) => w.weight >= threshold)
    .sort((a, b) => b.weight - a.weight);
  const limited = topK ? weighted.slice(0, topK) : weighted;
  return limited.map((w) => w.sample);
}

/** 減衰重みの合計 — 「十分な最近の証拠が溜まったか」の判定に有用。 */
export function weightedCount<T extends HardNegativeSample>(
  samples: T[],
  now: number = Date.now(),
): number {
  return weightSamples(samples, now).reduce((acc, w) => acc + w.weight, 0);
}
