/**
 * @torihanaku/kit-causal-inference — 因果推論エンジン
 *
 * Pure-TypeScript causal-inference algorithms extracted from 実運用SaaS.
 * All entry points take plain arrays/objects; no I/O, no env vars.
 */

// Shared statistical primitives
export {
  mean,
  variance,
  stdev,
  getZScore,
  normalCdf,
  linearRegression,
  standardErrorAt,
  type LinearFit,
} from './stats.js';

// Difference-in-Differences
export { runDid, type DidInput, type DidOutput } from './did.js';

// Propensity Score Matching
export { runPsm, type PsmInput, type PsmOutput } from './psm.js';

// Sharp RDD (+ Silverman rule-of-thumb bandwidth)
export {
  runRdd,
  silvermanBandwidth,
  type RddObservation,
  type RddInput,
  type RddOutput,
} from './rdd.js';

// Imbens–Kalyanaraman MSE-optimal bandwidth
export {
  imbensKalyanaramanBandwidth,
  type BandwidthMethod,
  type IkBandwidthResult,
} from './rdd-bandwidth.js';

// Fuzzy RDD (2SLS / Wald at the cutoff)
export {
  runFuzzyRdd,
  type FuzzyRddObservation,
  type FuzzyRddInput,
  type FuzzyRddOutput,
} from './rdd-fuzzy.js';

// Bayesian Online Change Point Detection
export {
  detectChangePoints,
  type ChangePointInput,
  type ChangePoint,
  type ChangePointOutput,
} from './change-point.js';

// Media Mix Modeling
export { runMmm } from './mmm.js';
export {
  type SaturationForm,
  type MmmChannelSeries,
  type MmmFitInput,
  type MmmChannelResult,
  type MmmFitOutput,
} from './mmm-types.js';
export {
  geometricAdstock,
  adstockEffectiveDuration,
  ADSTOCK_GRID,
} from './mmm-adstock.js';
export {
  saturate,
  hill,
  weibull,
  saturationPoint,
  saturationCurvePoints,
  SHAPE_GRID_HILL,
  SHAPE_GRID_WEIBULL,
  type SaturationParams,
} from './mmm-saturation.js';
export {
  bayesianFit,
  type ChannelParams,
  type FitState,
  type FitOutput,
} from './mmm-bayesian-fit.js';

// Counterfactual baseline projection
export {
  estimateCounterfactual,
  type CounterfactualInput,
  type CounterfactualResult,
} from './counterfactual.js';

// Natural-experiment (exogenous shock) detection
export {
  detectExogenousShocks,
  type DailyMetricPoint,
  type DetectedShock,
  type ShockDetectionOptions,
} from './natural-experiment.js';

// Incrementality test design (power analysis)
export { designTest, type TestDesignInput, type TestDesignOutput } from './design-test.js';

// MAPE tracking + drift detection
export {
  computeMape,
  computeBaselineMape,
  detectMapeDrift,
  DEFAULT_MAPE_DRIFT_THRESHOLD,
  type BaselineMapeRecord,
  type MapeObservation,
  type MapeDrift,
} from './mape.js';

// What-if scenario simulation (core simulator injected)
export {
  simulateWhatIf,
  exportToCsv,
  scenarioConfidenceLevel,
  toSimulatorInputs,
  SCENARIO_MULTIPLIERS,
  type WhatIfScenario,
  type WhatIfInput,
  type WhatIfPrediction,
  type WhatIfScenarioResult,
  type CoreSimulateFn,
  type CoreSimulateArgs,
  type CoreSimulateResult,
} from './whatif.js';
