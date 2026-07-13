/**
 * Eval run orchestrator: computes the KPI set, detects threshold
 * violations, and (optionally) persists the run via an injected store.
 *
 * Ported from 実運用SaaS `server/lib/eval/firewall-eval-runner.ts`
 * (#1040). Decoupled: Supabase persistence became {@link EvalRunStore};
 * metric names dropped the firewall-specific "lint_" prefix
 * (lint_f1 → f1 etc.); threshold values are the source defaults.
 */

import {
  computeClassificationMetrics,
  computeOverrideRetentionRate,
  computeRepeatCatchRate,
  type ClassificationMetrics,
  type OverrideEvent,
  type PredictionPair,
  type SubmissionForRepeatCatch,
} from "./metrics";

export interface ThresholdConfig {
  /** Minimum F1 — below this, alert. Default 0.7. */
  minF1: number;
  /** Minimum repeat-catch rate. Default 0.5. */
  minRepeatCatchRate: number;
  /** Maximum override retention rate (overfit guardrail). Default 0.4. */
  maxOverrideRetentionRate: number;
  /** Cosine similarity threshold for recurrence detection. Default 0.85. */
  similarityThreshold: number;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = Object.freeze({
  minF1: 0.7,
  minRepeatCatchRate: 0.5,
  maxOverrideRetentionRate: 0.4,
  similarityThreshold: 0.85,
});

export interface ThresholdViolation {
  metric: string;
  value: number;
  threshold: number;
  direction: "below_min" | "above_max";
}

export interface EvalRunInput {
  /** Golden ground-truth pairs (e.g. from `runGoldenCases().pairs`). */
  groundTruth: PredictionPair[];
  /** Recent decided submissions (for repeat-catch). Optional. */
  submissions?: SubmissionForRepeatCatch[];
  /** Override-approved events (for retention). Optional. */
  overrides?: OverrideEvent[];
  thresholds?: Partial<ThresholdConfig>;
  notes?: string;
}

export interface EvalRunRecord {
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  sampleSize: number;
  repeatCatchRate: number;
  repeatCaught: number;
  repeatTotal: number;
  overrideRetentionRate: number;
  overrideRecurring: number;
  overrideTotal: number;
  thresholdViolations: ThresholdViolation[];
  notes: string | null;
}

/** Injected persistence. Return the stored run id (or null). */
export interface EvalRunStore {
  saveRun(record: EvalRunRecord): Promise<string | null>;
}

export interface EvalRunResult {
  runId: string | null;
  classification: ClassificationMetrics;
  repeatCatch: { caught: number; repeatTotal: number; rate: number };
  override: { recurring: number; total: number; rate: number };
  violations: ThresholdViolation[];
}

export function detectViolations(
  classification: ClassificationMetrics,
  repeat: { rate: number },
  override: { rate: number },
  thresholds: ThresholdConfig,
): ThresholdViolation[] {
  const violations: ThresholdViolation[] = [];
  if (classification.f1 < thresholds.minF1) {
    violations.push({
      metric: "f1",
      value: classification.f1,
      threshold: thresholds.minF1,
      direction: "below_min",
    });
  }
  if (repeat.rate < thresholds.minRepeatCatchRate) {
    violations.push({
      metric: "repeat_catch_rate",
      value: repeat.rate,
      threshold: thresholds.minRepeatCatchRate,
      direction: "below_min",
    });
  }
  if (override.rate > thresholds.maxOverrideRetentionRate) {
    violations.push({
      metric: "override_retention_rate",
      value: override.rate,
      threshold: thresholds.maxOverrideRetentionRate,
      direction: "above_max",
    });
  }
  return violations;
}

export async function runEval(
  input: EvalRunInput,
  store?: EvalRunStore,
): Promise<EvalRunResult> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const classification = computeClassificationMetrics(input.groundTruth);
  const repeatCatch = computeRepeatCatchRate(
    input.submissions ?? [],
    thresholds.similarityThreshold,
  );
  const override = computeOverrideRetentionRate(
    input.overrides ?? [],
    thresholds.similarityThreshold,
  );
  const violations = detectViolations(classification, repeatCatch, override, thresholds);

  let runId: string | null = null;
  if (store) {
    try {
      runId = await store.saveRun({
        precision: classification.precision,
        recall: classification.recall,
        f1: classification.f1,
        accuracy: classification.accuracy,
        sampleSize: input.groundTruth.length,
        repeatCatchRate: repeatCatch.rate,
        repeatCaught: repeatCatch.caught,
        repeatTotal: repeatCatch.repeatTotal,
        overrideRetentionRate: override.rate,
        overrideRecurring: override.recurring,
        overrideTotal: override.total,
        thresholdViolations: violations,
        notes: input.notes ?? null,
      });
    } catch (error) {
      console.error(
        "[EvalRunner] persist failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    runId,
    classification,
    repeatCatch: {
      caught: repeatCatch.caught,
      repeatTotal: repeatCatch.repeatTotal,
      rate: repeatCatch.rate,
    },
    override: {
      recurring: override.recurring,
      total: override.total,
      rate: override.rate,
    },
    violations,
  };
}
