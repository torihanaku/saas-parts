/**
 * Sensitivity analysis (ported from dev-dashboard-v2 twin/sensitivity-service).
 *
 * Perturbs each input ±X% and measures the outcome delta vs the base scenario.
 * The multi-step variant runs a sweep of perturbation percentages. The
 * simulator is injected (`SimulateFn`); persistence for multi-step runs is
 * injected via `TwinStore`.
 */

import type { TwinStore } from "./store.js";
import type { TwinSimulation } from "./types.js";

type SimResult = Pick<TwinSimulation, "predictedOutputs">;

/** Simulator surface this service depends on. */
export type SimulateFn = (input: {
  tenantId: string;
  scenarioName: string;
  scenarioInputs: Record<string, number>;
}) => Promise<SimResult>;

export interface SensitivityInput {
  tenantId: string;
  baseScenario: Record<string, number>;
  perturbationPercent?: number;
}

export interface SensitivityOutput {
  inputs: Array<{
    key: string;
    baseValue: number;
    perturbations: {
      plus: { value: number; outcomeDelta: Record<string, number> };
      minus: { value: number; outcomeDelta: Record<string, number> };
    };
  }>;
}

function deltaOf(
  perturbed: { predictedOutputs: Record<string, { mean: number }> },
  base: { predictedOutputs: Record<string, { mean: number }> },
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of Object.keys(base.predictedOutputs)) {
    out[m] =
      (perturbed.predictedOutputs[m]?.mean ?? 0) -
      (base.predictedOutputs[m]?.mean ?? 0);
  }
  return out;
}

export async function analyzeSensitivity(
  input: SensitivityInput,
  simulate: SimulateFn,
): Promise<SensitivityOutput> {
  const pert = (input.perturbationPercent ?? 20) / 100;

  const baseSim = await simulate({
    tenantId: input.tenantId,
    scenarioName: "_sensitivity_base",
    scenarioInputs: input.baseScenario,
  });

  const results: SensitivityOutput["inputs"] = [];
  for (const [k, v] of Object.entries(input.baseScenario)) {
    const plusSim = await simulate({
      tenantId: input.tenantId,
      scenarioName: `_sens_${k}_plus`,
      scenarioInputs: { ...input.baseScenario, [k]: v * (1 + pert) },
    });
    const minusSim = await simulate({
      tenantId: input.tenantId,
      scenarioName: `_sens_${k}_minus`,
      scenarioInputs: { ...input.baseScenario, [k]: v * (1 - pert) },
    });

    results.push({
      key: k,
      baseValue: v,
      perturbations: {
        plus: { value: v * (1 + pert), outcomeDelta: deltaOf(plusSim, baseSim) },
        minus: {
          value: v * (1 - pert),
          outcomeDelta: deltaOf(minusSim, baseSim),
        },
      },
    });
  }

  return { inputs: results };
}

// ── Multi-step variant ───────────────────────────────────────────────────────

export const DEFAULT_SENSITIVITY_STEPS = [5, 10, 15, 20, 25] as const;

export interface SensitivityMultiStepInput {
  tenantId: string;
  baseScenario: Record<string, number>;
  steps?: number[];
  scenarioName?: string;
  /** Persist the run. Default true. */
  persist?: boolean;
}

export interface SensitivityStepResult {
  percent: number;
  plus: { value: number; outcomeDelta: Record<string, number> };
  minus: { value: number; outcomeDelta: Record<string, number> };
}

export interface SensitivityMultiStepOutput {
  inputs: Array<{
    key: string;
    baseValue: number;
    steps: SensitivityStepResult[];
  }>;
  runId: string | null;
}

export interface MultiStepDeps {
  simulate: SimulateFn;
  /** Store for persistence. Omit (or set persist=false) to skip persistence. */
  store?: TwinStore;
}

export async function analyzeSensitivityMultiStep(
  input: SensitivityMultiStepInput,
  deps: MultiStepDeps,
): Promise<SensitivityMultiStepOutput> {
  const steps = (
    input.steps && input.steps.length > 0
      ? input.steps
      : [...DEFAULT_SENSITIVITY_STEPS]
  )
    .map((p) => Number(p))
    .filter((p) => Number.isFinite(p) && p > 0);
  if (steps.length === 0) {
    throw new Error("steps must contain at least one positive percentage");
  }

  const baseSim = await deps.simulate({
    tenantId: input.tenantId,
    scenarioName: "_sens_ms_base",
    scenarioInputs: input.baseScenario,
  });

  const out: SensitivityMultiStepOutput["inputs"] = [];
  for (const [k, v] of Object.entries(input.baseScenario)) {
    const stepResults: SensitivityStepResult[] = [];
    for (const percent of steps) {
      const pert = percent / 100;
      const plusValue = v * (1 + pert);
      const minusValue = v * (1 - pert);

      const plusSim = await deps.simulate({
        tenantId: input.tenantId,
        scenarioName: `_sens_ms_${k}_plus_${percent}`,
        scenarioInputs: { ...input.baseScenario, [k]: plusValue },
      });
      const minusSim = await deps.simulate({
        tenantId: input.tenantId,
        scenarioName: `_sens_ms_${k}_minus_${percent}`,
        scenarioInputs: { ...input.baseScenario, [k]: minusValue },
      });

      stepResults.push({
        percent,
        plus: { value: plusValue, outcomeDelta: deltaOf(plusSim, baseSim) },
        minus: { value: minusValue, outcomeDelta: deltaOf(minusSim, baseSim) },
      });
    }
    out.push({ key: k, baseValue: v, steps: stepResults });
  }

  let runId: string | null = null;
  if (input.persist !== false && deps.store) {
    runId = await deps.store.insertSensitivityRun({
      tenantId: input.tenantId,
      scenarioName: input.scenarioName ?? "unnamed_run",
      baseScenario: input.baseScenario,
      stepsPercent: steps,
      results: { inputs: out },
      computedAt: new Date().toISOString(),
    });
  }

  return { inputs: out, runId };
}

export interface SensitivityRunSummary {
  id: string;
  scenarioName: string;
  computedAt: string;
  inputCount: number;
  topSensitiveKey: string | null;
}

export async function listSensitivityRuns(
  tenantId: string,
  store: TwinStore,
  limit = 10,
): Promise<SensitivityRunSummary[]> {
  const rows = await store.listSensitivityRuns(tenantId, limit);
  return rows.map((row) => {
    const inputs = (row.results?.inputs ??
      []) as SensitivityMultiStepOutput["inputs"];
    return {
      id: row.id,
      scenarioName: row.scenario_name,
      computedAt: row.computed_at,
      inputCount: inputs.length,
      topSensitiveKey: pickTopSensitiveInput(inputs),
    };
  });
}

function pickTopSensitiveInput(
  inputs: SensitivityMultiStepOutput["inputs"],
): string | null {
  if (inputs.length === 0) return null;
  let topKey: string | null = null;
  let topScore = -Infinity;
  for (const input of inputs) {
    let score = 0;
    for (const step of input.steps) {
      for (const value of Object.values(step.plus.outcomeDelta)) {
        score += Math.abs(value);
      }
      for (const value of Object.values(step.minus.outcomeDelta)) {
        score += Math.abs(value);
      }
    }
    if (score > topScore) {
      topScore = score;
      topKey = input.key;
    }
  }
  return topKey;
}
