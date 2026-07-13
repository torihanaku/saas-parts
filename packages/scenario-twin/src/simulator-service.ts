/**
 * Scenario twin simulator (ported from 実運用SaaS twin/simulator-service).
 *
 * Projects a scenario forward from the latest baseline using an elasticity
 * table (injected via `TwinMath.extractElasticities`), then layers a
 * monte-carlo distribution (`TwinMath.runMonteCarlo`) on top of the linear
 * ± z·std band. Persistence is injected via `TwinStore`.
 */

import type { PredictedOutput, TwinSimulation, TwinMath } from "./types.js";
import type { TwinStore } from "./store.js";

export interface SimulateInput {
  tenantId: string;
  scenarioName: string;
  scenarioInputs: Record<string, number>;
  periodHorizonDays?: number;
  confidenceLevel?: number;
  /** When true, skip monte carlo and use only the linear ± z·std band. */
  skipMonteCarlo?: boolean;
}

export interface SimulatorDeps {
  store: TwinStore;
  math: TwinMath;
}

export async function simulate(
  input: SimulateInput,
  deps: SimulatorDeps,
): Promise<TwinSimulation> {
  const baseline = await deps.store.getLatestBaseline(input.tenantId);

  if (!baseline) {
    return {
      id: "",
      tenantId: input.tenantId,
      scenarioName: input.scenarioName,
      scenarioInputs: input.scenarioInputs,
      periodHorizonDays: input.periodHorizonDays ?? 30,
      predictedOutputs: {},
      confidenceLevel: input.confidenceLevel ?? 0.8,
      modelVersion: "v2",
      baselineId: null,
      assumptions: [{ name: "baseline_exists", satisfied: false }],
      warnings: ["no_baseline_run_baseline_builder_first"],
      createdAt: new Date().toISOString(),
    };
  }

  const metrics = baseline.metrics;
  const elasticityResult = await deps.math.extractElasticities(input.tenantId);
  const elasticities = elasticityResult.table;
  const warnings: string[] = [...elasticityResult.warnings];

  const predicted: Record<string, PredictedOutput> = {};
  for (const [outputMetric, base] of Object.entries(metrics)) {
    let predictedMean = base.mean;
    for (const [inputKey, inputValue] of Object.entries(input.scenarioInputs)) {
      const e = elasticities[inputKey]?.[outputMetric] ?? 0;
      const inputBase = metrics[inputKey]?.mean ?? 1;
      const delta = (inputValue - inputBase) * e;
      predictedMean += delta;
    }

    const z = (input.confidenceLevel ?? 0.8) >= 0.95 ? 1.96 : 1.28;
    predicted[outputMetric] = {
      mean: Math.max(0, predictedMean),
      ciLower: Math.max(0, predictedMean - z * base.std),
      ciUpper: Math.max(0, predictedMean + z * base.std),
    };
  }

  // Monte carlo distribution layered on top of the linear projection.
  if (!input.skipMonteCarlo) {
    try {
      const mc = deps.math.runMonteCarlo({
        baseline: metrics,
        scenarioInputs: input.scenarioInputs,
        elasticities,
      });
      for (const [outputMetric, dist] of Object.entries(mc)) {
        const p = predicted[outputMetric];
        if (p) p.distribution = dist;
      }
    } catch (err) {
      warnings.push(
        `monte_carlo_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const assumptions: Array<{ name: string; satisfied: boolean; note?: string }> =
    [
      { name: "baseline_exists", satisfied: true },
      {
        name: elasticityResult.fromMmm
          ? "mmm_elasticities_used"
          : "elasticities_fallback",
        satisfied: elasticityResult.fromMmm,
        note: elasticityResult.fromMmm
          ? `saturation_form=${elasticityResult.formHint ?? "linear"}`
          : "using FALLBACK_ELASTICITIES — calibrate by running MMM first",
      },
    ];

  const sim = await deps.store.insertSimulation({
    tenantId: input.tenantId,
    scenarioName: input.scenarioName,
    scenarioInputs: input.scenarioInputs,
    periodHorizonDays: input.periodHorizonDays ?? 30,
    predictedOutputs: predicted,
    confidenceLevel: input.confidenceLevel ?? 0.8,
    modelVersion: "v2",
    baselineId: baseline.id,
    assumptions,
    warnings,
  });

  return {
    ...sim,
    causalProvenance: elasticityResult.causalProvenance,
    hasCausalOverride: elasticityResult.hasCausalOverride,
  };
}
