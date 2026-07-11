/**
 * Tests for sensitivity-service.ts (ported from dev-dashboard-v2
 * tests/twin-sensitivity.test.ts). `simulate` + store are injected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  analyzeSensitivity,
  analyzeSensitivityMultiStep,
  DEFAULT_SENSITIVITY_STEPS,
  type SimulateFn,
} from "./sensitivity-service.js";
import type { TwinStore } from "./store.js";

beforeEach(() => vi.clearAllMocks());

describe("analyzeSensitivity", () => {
  it("perturbs ±20% by default and computes outcome deltas", async () => {
    const simulate = vi.fn(async (input: { scenarioName: string }) => {
      if (input.scenarioName === "_sensitivity_base")
        return { predictedOutputs: { pv: { mean: 100 } } };
      if (input.scenarioName === "_sens_blog_count_plus")
        return { predictedOutputs: { pv: { mean: 120 } } };
      return { predictedOutputs: { pv: { mean: 80 } } };
    }) as unknown as SimulateFn;

    const result = await analyzeSensitivity(
      { tenantId: "t1", baseScenario: { blog_count: 10 } },
      simulate,
    );

    expect(result.inputs).toHaveLength(1);
    const r = result.inputs[0]!;
    expect(r.key).toBe("blog_count");
    expect(r.baseValue).toBe(10);
    expect(r.perturbations.plus.value).toBe(12);
    expect(r.perturbations.plus.outcomeDelta.pv).toBe(20);
    expect(r.perturbations.minus.value).toBe(8);
    expect(r.perturbations.minus.outcomeDelta.pv).toBe(-20);
  });

  it("honors a custom perturbationPercent", async () => {
    const simulate = vi.fn(async () => ({
      predictedOutputs: { cv: { mean: 50 } },
    })) as unknown as SimulateFn;

    const result = await analyzeSensitivity(
      { tenantId: "t1", baseScenario: { ad_budget: 100 }, perturbationPercent: 10 },
      simulate,
    );
    const r = result.inputs[0]!;
    expect(r.perturbations.plus.value).toBeCloseTo(110);
    expect(r.perturbations.minus.value).toBeCloseTo(90);
    expect(r.perturbations.plus.outcomeDelta.cv).toBe(0);
  });
});

describe("analyzeSensitivityMultiStep", () => {
  it("runs the default 5-step sweep and persists when a store is given", async () => {
    const simulate = vi.fn(async () => ({
      predictedOutputs: { pv: { mean: 100 } },
    })) as unknown as SimulateFn;
    const insertSensitivityRun = vi.fn().mockResolvedValue("run-1");
    const store = { insertSensitivityRun } as unknown as TwinStore;

    const out = await analyzeSensitivityMultiStep(
      { tenantId: "t1", baseScenario: { ad_budget: 100 } },
      { simulate, store },
    );

    expect(out.inputs[0]!.steps).toHaveLength(DEFAULT_SENSITIVITY_STEPS.length);
    expect(out.runId).toBe("run-1");
    expect(insertSensitivityRun).toHaveBeenCalledTimes(1);
  });

  it("skips persistence when persist=false", async () => {
    const simulate = vi.fn(async () => ({
      predictedOutputs: { pv: { mean: 100 } },
    })) as unknown as SimulateFn;
    const insertSensitivityRun = vi.fn();
    const store = { insertSensitivityRun } as unknown as TwinStore;

    const out = await analyzeSensitivityMultiStep(
      { tenantId: "t1", baseScenario: { ad_budget: 100 }, persist: false },
      { simulate, store },
    );
    expect(out.runId).toBeNull();
    expect(insertSensitivityRun).not.toHaveBeenCalled();
  });

  it("throws when steps are all invalid", async () => {
    const simulate = vi.fn() as unknown as SimulateFn;
    await expect(
      analyzeSensitivityMultiStep(
        { tenantId: "t1", baseScenario: { x: 1 }, steps: [-1, 0] },
        { simulate },
      ),
    ).rejects.toThrow(/at least one positive/);
  });
});
