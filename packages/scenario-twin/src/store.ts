/**
 * Injected persistence surface for the scenario twin.
 *
 * The original implementation talked to Supabase directly. Here every table
 * read/write is abstracted so the twin is backend-agnostic.
 */

import type {
  BaselineMetrics,
  PredictedOutput,
  TwinBaseline,
  TwinSimulation,
} from "./types.js";

// ── Baseline ─────────────────────────────────────────────────────────────────

/** Historical content-draft row (for baseline building). */
export interface ContentDraftRow {
  type?: string | null;
  created_at?: string | null;
}

/** Historical ad-insight row (for baseline building). */
export interface AdInsightRow {
  date?: string | null;
  spend_jpy?: number | string | null;
  impressions?: number | string | null;
  conversions?: number | string | null;
}

/** Row to persist for a computed baseline. */
export interface BaselineToStore {
  tenantId: string;
  snapshotDate: string;
  windowDays: number;
  metrics: BaselineMetrics;
  correlations: Record<string, unknown>;
}

// ── Simulation ───────────────────────────────────────────────────────────────

export interface SimulationToStore {
  tenantId: string;
  scenarioName: string;
  scenarioInputs: Record<string, number>;
  periodHorizonDays: number;
  predictedOutputs: Record<string, PredictedOutput>;
  confidenceLevel: number;
  modelVersion: string;
  baselineId: string;
  assumptions: Array<{ name: string; satisfied: boolean; note?: string }>;
  warnings: string[];
}

// ── Backtest ─────────────────────────────────────────────────────────────────

export interface BacktestRecord {
  id: string;
  tenant_id: string;
  simulation_id: string;
  metric: string;
  predicted: number | null;
  actual: number | null;
  error_percent: number | null;
  recorded_at: string;
}

export interface BacktestToStore {
  tenantId: string;
  simulationId: string;
  metric: string;
  predicted: number;
  actual: number;
  errorPercent: number | null;
  recordedAt: string;
}

// ── Sensitivity persistence ──────────────────────────────────────────────────

export interface SensitivityRunToStore {
  tenantId: string;
  scenarioName: string;
  baseScenario: Record<string, number>;
  stepsPercent: number[];
  results: unknown;
  computedAt: string;
}

export interface SensitivityRunRow {
  id: string;
  scenario_name: string;
  computed_at: string;
  results: { inputs?: Array<unknown> } | null;
}

/** The full persistence surface used by the twin services. */
export interface TwinStore {
  // baseline
  loadBaselineInputs(input: {
    tenantId: string;
    sinceIso: string;
  }): Promise<{ drafts: ContentDraftRow[]; insights: AdInsightRow[] }>;
  insertBaseline(row: BaselineToStore): Promise<string>;
  /** Latest baseline for the tenant, or null. Used by simulate(). */
  getLatestBaseline(tenantId: string): Promise<TwinBaseline | null>;

  // simulation
  insertSimulation(row: SimulationToStore): Promise<TwinSimulation>;

  // backtest
  insertBacktest(row: BacktestToStore): Promise<string>;
  listBacktest(tenantId: string, limit: number): Promise<BacktestRecord[]>;

  // sensitivity
  insertSensitivityRun(row: SensitivityRunToStore): Promise<string | null>;
  listSensitivityRuns(
    tenantId: string,
    limit: number,
  ): Promise<SensitivityRunRow[]>;
}
