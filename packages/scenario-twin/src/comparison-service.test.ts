/**
 * Tests for comparison-service.ts (ported from 実運用SaaS
 * tests/twin-compare.test.ts). `simulate` is injected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { compare, type SimulateFn } from "./comparison-service.js";

beforeEach(() => vi.clearAllMocks());

function pred(mean: number) {
  return { mean, ciLower: mean, ciUpper: mean };
}

describe("compare", () => {
  it("rejects fewer than 2 scenarios", async () => {
    const simulate = vi.fn() as unknown as SimulateFn;
    await expect(
      compare({ tenantId: "t1", scenarios: [{ name: "1", inputs: {} }] }, simulate),
    ).rejects.toThrow("compare_requires_2_or_3_scenarios");
  });

  it("rejects more than 3 scenarios", async () => {
    const simulate = vi.fn() as unknown as SimulateFn;
    await expect(
      compare(
        {
          tenantId: "t1",
          scenarios: [
            { name: "1", inputs: {} },
            { name: "2", inputs: {} },
            { name: "3", inputs: {} },
            { name: "4", inputs: {} },
          ],
        },
        simulate,
      ),
    ).rejects.toThrow("compare_requires_2_or_3_scenarios");
  });

  it("compares 2 scenarios with correct diff and best-by-metric", async () => {
    const simulate = vi.fn(async (input: { scenarioName: string }) => {
      if (input.scenarioName === "S1") {
        return {
          id: "sim1",
          scenarioName: "S1",
          predictedOutputs: { pv: pred(100), cv: pred(10) },
          warnings: [],
        };
      }
      return {
        id: "sim2",
        scenarioName: "S2",
        predictedOutputs: { pv: pred(150), cv: pred(8) },
        warnings: [],
      };
    }) as unknown as SimulateFn;

    const result = await compare(
      {
        tenantId: "t1",
        scenarios: [
          { name: "S1", inputs: { ad_budget: 100 } },
          { name: "S2", inputs: { ad_budget: 200 } },
        ],
      },
      simulate,
    );

    expect(result.scenarios).toHaveLength(2);
    expect(result.delta.pairs).toHaveLength(1);
    const pair = result.delta.pairs[0]!;
    expect(pair.from).toBe("S1");
    expect(pair.to).toBe("S2");
    expect(pair.diff.pv!.mean).toBe(50);
    expect(pair.diff.pv!.percent).toBe(50);
    expect(pair.diff.cv!.mean).toBe(-2);
    expect(pair.diff.cv!.percent).toBe(-20);
    expect(result.bestScenarioByMetric.pv).toBe("S2");
    expect(result.bestScenarioByMetric.cv).toBe("S1");
  });

  it("compares 3 scenarios and returns 3 pairs", async () => {
    const simulate = vi.fn(async (input: { scenarioName: string }) => ({
      id: "sim",
      scenarioName: input.scenarioName,
      predictedOutputs: { pv: pred(100) },
      warnings: [],
    })) as unknown as SimulateFn;

    const result = await compare(
      {
        tenantId: "t1",
        scenarios: [
          { name: "S1", inputs: {} },
          { name: "S2", inputs: {} },
          { name: "S3", inputs: {} },
        ],
      },
      simulate,
    );
    expect(result.delta.pairs).toHaveLength(3);
    expect(result.delta.pairs.map((p) => `${p.from}-${p.to}`)).toEqual([
      "S1-S2",
      "S1-S3",
      "S2-S3",
    ]);
  });
});
