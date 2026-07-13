/**
 * LLM/classifier evaluation metrics.
 *
 * Pure, side-effect-free metric calculators consumed by the eval runner
 * and directly by dashboards.
 *
 * Ported from 実運用SaaS `server/lib/eval/firewall-metrics.ts`
 * (#1040 Brand Firewall observability). The three KPI families are generic:
 *   1. precision / recall / F1 / accuracy against a ground-truth dataset
 *   2. "repeat-catch rate" (similar edge cases auto-rejected on the
 *      second-and-onward sighting — hard-negatives learning signal)
 *   3. "override retention rate" (human-override-approved cases that recur
 *      and again require an override → potential overfit signal)
 */

export interface ConfusionMatrix {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
}

export interface ClassificationMetrics extends ConfusionMatrix {
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
}

export interface PredictionPair {
  /** Ground-truth label: should this input have been flagged? */
  expected: boolean;
  /** The system's actual verdict. */
  predicted: boolean;
}

function safeDivide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function computeConfusionMatrix(pairs: PredictionPair[]): ConfusionMatrix {
  const m: ConfusionMatrix = {
    truePositive: 0,
    falsePositive: 0,
    trueNegative: 0,
    falseNegative: 0,
  };
  for (const p of pairs) {
    if (p.predicted && p.expected) m.truePositive++;
    else if (p.predicted && !p.expected) m.falsePositive++;
    else if (!p.predicted && !p.expected) m.trueNegative++;
    else m.falseNegative++;
  }
  return m;
}

/**
 * Classification metrics. F1 weights precision and recall equally — the
 * right choice when both false positives (annoying false flags) and false
 * negatives (missed violations) hurt the user.
 */
export function computeClassificationMetrics(pairs: PredictionPair[]): ClassificationMetrics {
  const m = computeConfusionMatrix(pairs);
  const precision = safeDivide(m.truePositive, m.truePositive + m.falsePositive);
  const recall = safeDivide(m.truePositive, m.truePositive + m.falseNegative);
  const f1 = safeDivide(2 * precision * recall, precision + recall);
  const accuracy = safeDivide(m.truePositive + m.trueNegative, pairs.length);
  return { ...m, precision, recall, f1, accuracy };
}

/**
 * Mean Absolute Percentage Error. Useful for accuracy-based alert thresholds
 * (e.g. "MAPE > 15% → warn"); feed (1 - accuracy) into a percentage.
 */
export function computeMape(predicted: number[], actual: number[]): number {
  if (predicted.length === 0 || predicted.length !== actual.length) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < predicted.length; i++) {
    const a = actual[i];
    const p = predicted[i];
    if (a === undefined || p === undefined || a === 0) continue;
    sum += Math.abs((a - p) / a);
    count++;
  }
  return count === 0 ? 0 : (sum / count) * 100;
}

export interface SubmissionForRepeatCatch {
  /** Embedding vector of the rejected submission. */
  embedding: number[];
  /** When the submission was decided (ISO timestamp). */
  decidedAt: string;
  /** Did the system auto-reject on this sighting? */
  autoRejected: boolean;
}

/**
 * Repeat-catch rate: proportion of submissions whose embedding was within
 * `similarityThreshold` cosine of an earlier submission AND were
 * auto-rejected on this sighting. High value = the hard-negatives pipeline
 * is learning effectively.
 */
export function computeRepeatCatchRate(
  submissions: SubmissionForRepeatCatch[],
  similarityThreshold: number = 0.85,
): { repeatTotal: number; caught: number; rate: number } {
  const sorted = [...submissions].sort(
    (a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt),
  );
  const seen: SubmissionForRepeatCatch[] = [];
  let repeatTotal = 0;
  let caught = 0;
  for (const cur of sorted) {
    const isRepeat = seen.some(
      (prev) => cosineSimilarity(prev.embedding, cur.embedding) >= similarityThreshold,
    );
    if (isRepeat) {
      repeatTotal++;
      if (cur.autoRejected) caught++;
    }
    seen.push(cur);
  }
  return { repeatTotal, caught, rate: safeDivide(caught, repeatTotal) };
}

export interface OverrideEvent {
  embedding: number[];
  /** When the override was approved (ISO timestamp). */
  decidedAt: string;
}

/**
 * Override retention rate: of all override-approved cases, how many had a
 * later similar override-approved case. High retention can signal
 * overfitting (the system keeps flagging things a human has explicitly
 * approved patterns for).
 */
export function computeOverrideRetentionRate(
  overrides: OverrideEvent[],
  similarityThreshold: number = 0.85,
): { total: number; recurring: number; rate: number } {
  if (overrides.length < 2) return { total: overrides.length, recurring: 0, rate: 0 };
  const sorted = [...overrides].sort(
    (a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt),
  );
  let recurring = 0;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (
      sorted
        .slice(0, i)
        .some((prev) => cosineSimilarity(prev.embedding, cur.embedding) >= similarityThreshold)
    ) {
      recurring++;
    }
  }
  return { total: sorted.length, recurring, rate: safeDivide(recurring, sorted.length) };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export const __test = { cosineSimilarity, safeDivide };
