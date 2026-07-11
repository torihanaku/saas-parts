/**
 * @torihanaku/scenario-twin
 *
 * A digital twin for marketing-mix scenarios: build a baseline, simulate
 * scenarios, compare them, run sensitivity sweeps, backtest predictions, and
 * bridge causal-experiment effect-sizes into elasticities.
 *
 * Monte-carlo + elasticity extraction are injected (`TwinMath`) and all
 * persistence is injected (`TwinStore`). `@torihanaku/stats-sim` satisfies the
 * `TwinMath` interface — see README.
 */

export * from "./types.js";
export * from "./store.js";
export * from "./simulator-service.js";

// baseline-builder (its `__testing` is namespaced to avoid a collision).
export { buildBaseline } from "./baseline-builder.js";
export { __testing as baselineTesting } from "./baseline-builder.js";

// comparison-service (`SimulateFn` here is aliased to avoid clashing with the
// sensitivity one — they have different shapes).
export {
  compare,
  type CompareInput,
  type CompareOutput,
  type SimulateFn as CompareSimulateFn,
} from "./comparison-service.js";

// sensitivity-service.
export {
  analyzeSensitivity,
  analyzeSensitivityMultiStep,
  listSensitivityRuns,
  DEFAULT_SENSITIVITY_STEPS,
  type SensitivityInput,
  type SensitivityOutput,
  type SensitivityMultiStepInput,
  type SensitivityMultiStepOutput,
  type SensitivityStepResult,
  type SensitivityRunSummary,
  type MultiStepDeps,
  type SimulateFn as SensitivitySimulateFn,
} from "./sensitivity-service.js";

// backtest-service (`BacktestRecord` also comes from store; export the value
// fns + accuracy type here and let store own the record type).
export {
  recordBacktest,
  listBacktest,
  calculateAccuracy,
  type BacktestAccuracy,
} from "./backtest-service.js";

// causal-link (`__testing` namespaced).
export {
  saveCausalToTwinLink,
  getTenantCausalLinks,
  buildCausalElasticityTable,
  channelToInputKey,
  rowToDto,
  type CausalToTwinLink,
  type SaveCausalLinkInput,
  type CausalLinkRow,
  type CausalLinkStore,
  type CausalElasticityResult,
} from "./causal-link.js";
export { __testing as causalLinkTesting } from "./causal-link.js";

export * from "./client/useTwin.js";
