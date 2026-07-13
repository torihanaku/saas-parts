/**
 * Scenario Twin — shared types + injected dependency interfaces.
 * Ported from 実運用SaaS `server/lib/twin/*` (Epic B5).
 *
 * The digital twin projects marketing-mix scenarios forward. Monte-carlo and
 * elasticity extraction are injected as callbacks (`TwinMath`), and all
 * persistence is behind `TwinStore`, so this package is self-contained.
 * `@torihanaku/stats-sim` satisfies the `TwinMath` interface (see README).
 */

/** Per-metric baseline statistics. */
export interface MetricStat {
  mean: number;
  std: number;
}

/** `{ metricName -> { mean, std } }`. */
export type BaselineMetrics = Record<string, MetricStat>;

/** Empirical distribution returned by monte-carlo per output metric. */
export interface MonteCarloDistribution {
  mean: number;
  ciLower: number;
  ciUpper: number;
  p10?: number;
  p50?: number;
  p90?: number;
  samples?: number;
  [k: string]: unknown;
}

/** `{ inputKey -> { outputMetric -> elasticity coefficient } }`. */
export type ElasticityTable = Record<string, Record<string, number>>;

/** Result of elasticity extraction (with provenance + warnings). */
export interface ElasticityResult {
  table: ElasticityTable;
  warnings: string[];
  /** True when elasticities came from the MMM regression (vs fallback). */
  fromMmm: boolean;
  /** Saturation form hint for the assumptions annotation. */
  formHint?: string;
  /** experiment_id per (inputKey, outputMetric) when a causal link overrode. */
  causalProvenance?: Record<string, Record<string, string>>;
  /** True when at least one cell was sourced from a causal link. */
  hasCausalOverride?: boolean;
}

export interface PredictedOutput {
  mean: number;
  ciLower: number;
  ciUpper: number;
  distribution?: MonteCarloDistribution;
}

export interface TwinBaseline {
  id: string;
  tenantId: string;
  snapshotDate: string;
  windowDays: number;
  metrics: BaselineMetrics;
  correlations: Record<string, unknown>;
}

export interface TwinSimulation {
  id: string;
  tenantId: string;
  scenarioName: string;
  scenarioInputs: Record<string, number>;
  periodHorizonDays: number;
  predictedOutputs: Record<string, PredictedOutput>;
  confidenceLevel: number;
  modelVersion: string;
  baselineId: string | null;
  assumptions: Array<{ name: string; satisfied: boolean; note?: string }>;
  warnings: string[];
  createdAt: string;
  causalProvenance?: Record<string, Record<string, string>>;
  hasCausalOverride?: boolean;
}

// ─── Injected math ───────────────────────────────────────────────────────────

/** Input to a monte-carlo run. */
export interface MonteCarloInput {
  baseline: BaselineMetrics;
  scenarioInputs: Record<string, number>;
  elasticities: ElasticityTable;
}

/**
 * Injected numerical surface. `@torihanaku/stats-sim` provides implementations
 * that satisfy this interface (Monte-Carlo simulation + elasticity extraction).
 */
export interface TwinMath {
  /**
   * Run a monte-carlo projection. Returns `{ outputMetric -> distribution }`.
   * May throw; the simulator catches and degrades to the linear band.
   */
  runMonteCarlo(input: MonteCarloInput): Record<string, MonteCarloDistribution>;
  /**
   * Extract the elasticity table for a tenant (MMM betas with causal-link
   * preference + fallback). Async because it typically reads model results.
   */
  extractElasticities(tenantId: string): Promise<ElasticityResult>;
}
