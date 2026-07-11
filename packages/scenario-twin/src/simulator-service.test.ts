/**
 * Tests for simulator-service.ts. Store + math (monte-carlo / elasticities) are
 * injected as fakes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { simulate } from "./simulator-service.js";
import type { TwinStore } from "./store.js";
import type { TwinMath, TwinBaseline, ElasticityResult } from "./types.js";

const getLatestBaseline = vi.fn();
const insertSimulation = vi.fn();
const runMonteCarlo = vi.fn();
const extractElasticities = vi.fn();

const store = { getLatestBaseline, insertSimulation } as unknown as TwinStore;
const math: TwinMath = { runMonteCarlo, extractElasticities };

const baseline: TwinBaseline = {
  id: "b1",
  tenantId: "t1",
  snapshotDate: "2026-05-01T00:00:00Z",
  windowDays: 90,
  metrics: {
    pv: { mean: 1000, std: 100 },
    ad_budget: { mean: 100, std: 10 },
  },
  correlations: {},
};

const elasticityOk: ElasticityResult = {
  table: { ad_budget: { pv: 2 } },
  warnings: [],
  fromMmm: true,
  formHint: "linear",
};

beforeEach(() => {
  vi.clearAllMocks();
  getLatestBaseline.mockResolvedValue(baseline);
  extractElasticities.mockResolvedValue(elasticityOk);
  runMonteCarlo.mockReturnValue({});
  insertSimulation.mockImplementation(async (row) => ({
    id: "sim-1",
    tenantId: row.tenantId,
    scenarioName: row.scenarioName,
    scenarioInputs: row.scenarioInputs,
    periodHorizonDays: row.periodHorizonDays,
    predictedOutputs: row.predictedOutputs,
    confidenceLevel: row.confidenceLevel,
    modelVersion: row.modelVersion,
    baselineId: row.baselineId,
    assumptions: row.assumptions,
    warnings: row.warnings,
    createdAt: "2026-05-02T00:00:00Z",
  }));
});

describe("simulate", () => {
  it("returns a fail-closed result when there is no baseline", async () => {
    getLatestBaseline.mockResolvedValueOnce(null);
    const sim = await simulate(
      { tenantId: "t1", scenarioName: "s", scenarioInputs: {} },
      { store, math },
    );
    expect(sim.warnings).toContain("no_baseline_run_baseline_builder_first");
    expect(sim.baselineId).toBeNull();
    expect(insertSimulation).not.toHaveBeenCalled();
  });

  it("applies elasticity delta to the predicted mean", async () => {
    // ad_budget 100 -> 150 (delta +50), elasticity 2 => +100 on pv (base 1000)
    const sim = await simulate(
      { tenantId: "t1", scenarioName: "s", scenarioInputs: { ad_budget: 150 } },
      { store, math },
    );
    expect(sim.predictedOutputs.pv!.mean).toBe(1100);
    expect(sim.id).toBe("sim-1");
    expect(extractElasticities).toHaveBeenCalledWith("t1");
  });

  it("layers a monte-carlo distribution when provided", async () => {
    runMonteCarlo.mockReturnValueOnce({
      pv: { mean: 1080, ciLower: 900, ciUpper: 1260 },
    });
    const sim = await simulate(
      { tenantId: "t1", scenarioName: "s", scenarioInputs: { ad_budget: 150 } },
      { store, math },
    );
    expect(sim.predictedOutputs.pv!.distribution?.mean).toBe(1080);
  });

  it("degrades gracefully when monte-carlo throws", async () => {
    runMonteCarlo.mockImplementationOnce(() => {
      throw new Error("mc boom");
    });
    const sim = await simulate(
      { tenantId: "t1", scenarioName: "s", scenarioInputs: {} },
      { store, math },
    );
    expect(sim.warnings.some((w) => w.startsWith("monte_carlo_failed"))).toBe(true);
  });

  it("skips monte-carlo when skipMonteCarlo is set", async () => {
    await simulate(
      {
        tenantId: "t1",
        scenarioName: "s",
        scenarioInputs: {},
        skipMonteCarlo: true,
      },
      { store, math },
    );
    expect(runMonteCarlo).not.toHaveBeenCalled();
  });

  it("annotates the fallback assumption when not from MMM", async () => {
    extractElasticities.mockResolvedValueOnce({
      table: {},
      warnings: ["using fallback"],
      fromMmm: false,
    });
    const sim = await simulate(
      { tenantId: "t1", scenarioName: "s", scenarioInputs: {} },
      { store, math },
    );
    const a = sim.assumptions.find((x) => x.name === "elasticities_fallback")!;
    expect(a.satisfied).toBe(false);
  });
});
