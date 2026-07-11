export {
  computeConfusionMatrix,
  computeClassificationMetrics,
  computeMape,
  computeRepeatCatchRate,
  computeOverrideRetentionRate,
  __test,
  type ConfusionMatrix,
  type ClassificationMetrics,
  type PredictionPair,
  type SubmissionForRepeatCatch,
  type OverrideEvent,
} from "./metrics";

export {
  runGoldenCases,
  type GoldenCase,
  type JudgeFn,
  type GoldenCaseResult,
  type GoldenRunResult,
} from "./golden";

export {
  runEval,
  detectViolations,
  DEFAULT_THRESHOLDS,
  type ThresholdConfig,
  type ThresholdViolation,
  type EvalRunInput,
  type EvalRunRecord,
  type EvalRunStore,
  type EvalRunResult,
} from "./runner";

export {
  compareRuns,
  COMPARABLE_METRICS,
  type ComparableMetric,
  type MetricDelta,
  type RunComparison,
  type CompareOptions,
} from "./regression";

export { EXAMPLE_GOLDEN_CASES } from "./fixtures";
