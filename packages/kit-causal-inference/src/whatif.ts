/**
 * What-If scenario simulation — the algorithm parts of the what-if service:
 * scenario multipliers, confidence-level mapping, input mapping, and CSV
 * export.
 *
 * Ported from dev-dashboard-v2 `server/services/whatIfSimulator.ts` (types
 * from `shared/types/whatif.ts`). Changes vs. origin:
 *   - The core predictive simulator (`server/lib/twin/simulator-service`) is
 *     NOT bundled here — it is extracted separately as `@torihanaku/stats-sim`.
 *     Callers inject any compatible simulator via the `simulate` callback.
 *   - Redis caching and the SHA-256 cache key were dropped (infrastructure;
 *     the caller can memoise around `simulateWhatIf` if desired).
 * Numerics (multipliers 0.8/1.0/1.2, confidence 0.6/0.8/0.95, 30-day
 * horizon, rounding, default pv=1000 / cv=10 fallbacks, CSV layout)
 * unchanged.
 */

export type WhatIfScenario = 'pessimistic' | 'realistic' | 'optimistic';

export interface WhatIfInput {
  blogPosts?: number;
  adBudget?: number;
  emailFrequency?: number;
  [key: string]: number | undefined;
}

export interface WhatIfPrediction {
  pv: number;
  cv: number;
  [key: string]: number;
}

export interface WhatIfScenarioResult {
  scenario: WhatIfScenario;
  inputs: WhatIfInput;
  predictedOutputs: WhatIfPrediction;
  confidenceLevel: number;
}

/** Scenario multipliers applied to the simulator's mean predictions. */
export const SCENARIO_MULTIPLIERS: Record<WhatIfScenario, number> = {
  pessimistic: 0.8,
  realistic: 1.0,
  optimistic: 1.2,
};

/** Confidence level requested from the core simulator per scenario. */
export function scenarioConfidenceLevel(scenario: WhatIfScenario): number {
  return scenario === 'optimistic' ? 0.95 : scenario === 'pessimistic' ? 0.6 : 0.8;
}

/**
 * Map the UI-facing what-if inputs to the core simulator's snake_case
 * scenario-input keys. Unset inputs are omitted.
 */
export function toSimulatorInputs(inputs: WhatIfInput): Record<string, number> {
  const scenarioInputs: Record<string, number> = {};
  if (inputs.blogPosts !== undefined) scenarioInputs.blog_count = inputs.blogPosts;
  if (inputs.adBudget !== undefined) scenarioInputs.ad_budget = inputs.adBudget;
  if (inputs.emailFrequency !== undefined) scenarioInputs.email_frequency = inputs.emailFrequency;
  return scenarioInputs;
}

/** Minimal result shape required from the injected core simulator. */
export interface CoreSimulateResult {
  predictedOutputs: {
    pv?: { mean: number };
    cv?: { mean: number };
  };
  confidenceLevel: number;
}

export interface CoreSimulateArgs {
  scenarioName: string;
  scenarioInputs: Record<string, number>;
  periodHorizonDays: number;
  confidenceLevel: number;
}

/**
 * Injected core simulator (e.g. the Monte-Carlo twin simulator from
 * `@torihanaku/stats-sim`). May be sync or async.
 */
export type CoreSimulateFn = (
  args: CoreSimulateArgs,
) => Promise<CoreSimulateResult> | CoreSimulateResult;

export async function simulateWhatIf(params: {
  inputs: WhatIfInput;
  scenario?: WhatIfScenario;
  /** Injected predictive core (dependency injection — no bundled model). */
  simulate: CoreSimulateFn;
}): Promise<WhatIfScenarioResult> {
  const scenario = params.scenario || 'realistic';

  // 1. Convert WhatIfInput to simulator format
  const scenarioInputs = toSimulatorInputs(params.inputs);

  // 2. Call injected core simulator
  const simResult = await params.simulate({
    scenarioName: `WhatIf_${scenario}`,
    scenarioInputs,
    periodHorizonDays: 30,
    confidenceLevel: scenarioConfidenceLevel(scenario),
  });

  // 3. Apply scenario multipliers (pessimistic, realistic, optimistic)
  const multiplier = SCENARIO_MULTIPLIERS[scenario];

  const predictedOutputs: WhatIfPrediction = {
    pv: Math.round((simResult.predictedOutputs.pv?.mean || 1000) * multiplier),
    cv: Math.round((simResult.predictedOutputs.cv?.mean || 10) * multiplier),
  };

  return {
    scenario,
    inputs: params.inputs,
    predictedOutputs,
    confidenceLevel: simResult.confidenceLevel,
  };
}

export function exportToCsv(results: WhatIfScenarioResult[]): string {
  const headers = ['Scenario', 'Blog Posts', 'Ad Budget', 'Email Freq', 'Predicted PV', 'Predicted CV'];
  const rows = results.map(r => [
    r.scenario,
    r.inputs.blogPosts || 0,
    r.inputs.adBudget || 0,
    r.inputs.emailFrequency || 0,
    r.predictedOutputs.pv || 0,
    r.predictedOutputs.cv || 0,
  ]);

  return [
    headers.join(','),
    ...rows.map(row => row.join(',')),
  ].join('\n');
}
