/**
 * Scenario comparison (ported from 実運用SaaS twin/comparison-service).
 *
 * Runs 2–3 scenarios through the simulator and computes pairwise diffs + the
 * best scenario per metric. The simulator is injected as `SimulateFn` so this
 * module stays decoupled from persistence.
 */

import type { PredictedOutput, TwinSimulation } from "./types.js";

/** Simulator surface this service depends on. */
export type SimulateFn = (input: {
  tenantId: string;
  scenarioName: string;
  scenarioInputs: Record<string, number>;
  periodHorizonDays?: number;
  confidenceLevel?: number;
}) => Promise<Pick<TwinSimulation, "id" | "scenarioName" | "predictedOutputs" | "warnings">>;

export interface CompareInput {
  tenantId: string;
  scenarios: Array<{ name: string; inputs: Record<string, number> }>;
  periodHorizonDays?: number;
  confidenceLevel?: number;
}

export interface CompareOutput {
  scenarios: Array<{
    name: string;
    simulationId: string;
    predictedOutputs: Record<string, PredictedOutput>;
    warnings: string[];
  }>;
  delta: {
    pairs: Array<{
      from: string;
      to: string;
      diff: Record<string, { mean: number; percent: number }>;
    }>;
  };
  bestScenarioByMetric: Record<string, string>;
}

export async function compare(
  input: CompareInput,
  simulate: SimulateFn,
): Promise<CompareOutput> {
  if (input.scenarios.length < 2 || input.scenarios.length > 3) {
    throw new Error("compare_requires_2_or_3_scenarios");
  }

  const sims = await Promise.all(
    input.scenarios.map((s) =>
      simulate({
        tenantId: input.tenantId,
        scenarioName: s.name,
        scenarioInputs: s.inputs,
        periodHorizonDays: input.periodHorizonDays,
        confidenceLevel: input.confidenceLevel,
      }),
    ),
  );

  const pairs: CompareOutput["delta"]["pairs"] = [];
  for (let i = 0; i < sims.length; i++) {
    for (let j = i + 1; j < sims.length; j++) {
      const from = sims[i]!;
      const to = sims[j]!;
      const diff: Record<string, { mean: number; percent: number }> = {};
      for (const metric of Object.keys(to.predictedOutputs)) {
        const fromMean = from.predictedOutputs[metric]?.mean ?? 0;
        const toMean = to.predictedOutputs[metric]?.mean ?? 0;
        const d = toMean - fromMean;
        const pct = fromMean > 0 ? (d / fromMean) * 100 : 0;
        diff[metric] = { mean: d, percent: pct };
      }
      pairs.push({ from: from.scenarioName, to: to.scenarioName, diff });
    }
  }

  const bestScenarioByMetric: Record<string, string> = {};
  const first = sims[0];
  if (first && first.predictedOutputs) {
    const metrics = Object.keys(first.predictedOutputs);
    for (const m of metrics) {
      const best = sims.reduce((b, s) =>
        (s.predictedOutputs[m]?.mean ?? 0) > (b.predictedOutputs[m]?.mean ?? 0)
          ? s
          : b,
      );
      bestScenarioByMetric[m] = best.scenarioName;
    }
  }

  return {
    scenarios: sims.map((s) => ({
      name: s.scenarioName,
      simulationId: s.id,
      predictedOutputs: s.predictedOutputs,
      warnings: s.warnings,
    })),
    delta: { pairs },
    bestScenarioByMetric,
  };
}
