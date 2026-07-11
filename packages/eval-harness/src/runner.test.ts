/**
 * Tests for the generalized eval runner, golden-case runner and regression
 * comparison. Threshold/violation semantics ported from dev-dashboard-v2
 * `server/lib/eval/firewall-eval-runner.ts` (#1040); Supabase persistence
 * replaced by the injected store.
 */
import { describe, it, expect, vi } from "vitest";

import { computeClassificationMetrics, type PredictionPair } from "./metrics";
import {
  DEFAULT_THRESHOLDS,
  detectViolations,
  runEval,
  type EvalRunRecord,
} from "./runner";
import { runGoldenCases } from "./golden";
import { compareRuns } from "./regression";
import { EXAMPLE_GOLDEN_CASES } from "./fixtures";

const perfectPairs: PredictionPair[] = [
  { expected: true, predicted: true },
  { expected: true, predicted: true },
  { expected: false, predicted: false },
  { expected: false, predicted: false },
];

const poorPairs: PredictionPair[] = [
  { expected: true, predicted: false },
  { expected: true, predicted: false },
  { expected: false, predicted: true },
  { expected: false, predicted: false },
];

describe("detectViolations", () => {
  it("returns no violations when all KPIs are within thresholds", () => {
    const classification = computeClassificationMetrics(perfectPairs);
    const v = detectViolations(
      classification,
      { rate: 0.9 },
      { rate: 0.1 },
      DEFAULT_THRESHOLDS,
    );
    expect(v).toEqual([]);
  });

  it("flags f1 below min, repeat-catch below min, override retention above max", () => {
    const classification = computeClassificationMetrics(poorPairs);
    const v = detectViolations(classification, { rate: 0.2 }, { rate: 0.7 }, DEFAULT_THRESHOLDS);
    expect(v.map((x) => x.metric)).toEqual(["f1", "repeat_catch_rate", "override_retention_rate"]);
    expect(v[0]?.direction).toBe("below_min");
    expect(v[2]?.direction).toBe("above_max");
  });
});

describe("runEval", () => {
  it("computes KPIs, persists via injected store, and returns the run id", async () => {
    const saveRun = vi.fn(async (record: EvalRunRecord) => {
      expect(record.f1).toBeCloseTo(1, 5);
      expect(record.sampleSize).toBe(4);
      expect(record.notes).toBe("nightly");
      return "run-1";
    });

    const result = await runEval(
      {
        groundTruth: perfectPairs,
        submissions: [
          { embedding: [1, 0], decidedAt: "2026-04-01T00:00:00Z", autoRejected: false },
          { embedding: [1, 0], decidedAt: "2026-04-02T00:00:00Z", autoRejected: true },
        ],
        overrides: [],
        notes: "nightly",
      },
      { saveRun },
    );

    expect(result.runId).toBe("run-1");
    expect(result.classification.f1).toBeCloseTo(1, 5);
    expect(result.repeatCatch).toEqual({ caught: 1, repeatTotal: 1, rate: 1 });
    expect(result.violations).toEqual([]);
  });

  it("works without a store and without submissions/overrides", async () => {
    const result = await runEval({ groundTruth: poorPairs });
    expect(result.runId).toBeNull();
    // f1=0 < 0.7 and repeat rate 0 < 0.5; override rate 0 is fine.
    expect(result.violations.map((v) => v.metric)).toEqual(["f1", "repeat_catch_rate"]);
  });

  it("survives a failing store (persist is best-effort)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runEval(
      { groundTruth: perfectPairs, submissions: [], overrides: [] },
      { saveRun: vi.fn().mockRejectedValue(new Error("db down")) },
    );
    expect(result.runId).toBeNull();
    expect(result.classification.accuracy).toBe(1);
    consoleErrorSpy.mockRestore();
  });

  it("honors custom thresholds", async () => {
    const result = await runEval({
      groundTruth: perfectPairs,
      thresholds: { minRepeatCatchRate: 0 },
    });
    expect(result.violations).toEqual([]);
  });
});

describe("runGoldenCases", () => {
  it("runs a judge over the golden set and computes metrics + failures", async () => {
    // Naive keyword judge: misses "業界No.1" and "定期購入" cases on purpose.
    const judge = (input: string) => /絶対|治り|本日限り/.test(input);
    const run = await runGoldenCases(EXAMPLE_GOLDEN_CASES, judge);

    expect(run.results).toHaveLength(EXAMPLE_GOLDEN_CASES.length);
    expect(run.pairs).toHaveLength(EXAMPLE_GOLDEN_CASES.length);
    // 3 of 5 positives caught, all 5 negatives pass.
    expect(run.metrics.truePositive).toBe(3);
    expect(run.metrics.falseNegative).toBe(2);
    expect(run.metrics.falsePositive).toBe(0);
    expect(run.failures.map((f) => f.id).sort()).toEqual([
      "flag-hidden-subscription",
      "flag-unsubstantiated-no1",
    ]);
  });

  it("supports async judges (LLM callbacks)", async () => {
    const judge = vi.fn(async (input: string) => input.includes("flag"));
    const run = await runGoldenCases(
      [
        { id: "a", input: "flag me", expected: true },
        { id: "b", input: "leave me", expected: false },
      ],
      judge,
    );
    expect(run.metrics.accuracy).toBe(1);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it("captures judge errors as failed cases without aborting the run", async () => {
    const judge = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("LLM timeout"));
    const run = await runGoldenCases(
      [
        { id: "ok", input: "x", expected: true },
        { id: "boom", input: "y", expected: true },
      ],
      judge,
    );
    expect(run.results[0]?.pass).toBe(true);
    expect(run.results[1]?.pass).toBe(false);
    expect(run.results[1]?.error).toBe("LLM timeout");
    expect(run.failures).toHaveLength(1);
  });
});

describe("compareRuns", () => {
  const baseline = computeClassificationMetrics(perfectPairs);

  it("passes when the current run matches the baseline", () => {
    const cmp = compareRuns(baseline, computeClassificationMetrics(perfectPairs));
    expect(cmp.passed).toBe(true);
    expect(cmp.regressions).toEqual([]);
    expect(cmp.deltas).toHaveLength(4);
  });

  it("detects regressions when metrics drop", () => {
    const current = computeClassificationMetrics(poorPairs);
    const cmp = compareRuns(baseline, current);
    expect(cmp.passed).toBe(false);
    expect(cmp.regressions.map((r) => r.metric)).toEqual([
      "precision",
      "recall",
      "f1",
      "accuracy",
    ]);
    expect(cmp.regressions[0]?.delta).toBeLessThan(0);
  });

  it("tolerance absorbs small dips and flags improvements symmetrically", () => {
    const current = { precision: 0.995, recall: 1, f1: 0.997, accuracy: 1 };
    const cmp = compareRuns(baseline, current, { tolerance: 0.01 });
    expect(cmp.passed).toBe(true);

    const improved = compareRuns(
      { precision: 0.5, recall: 0.5, f1: 0.5, accuracy: 0.5 },
      baseline,
      { tolerance: 0.01 },
    );
    expect(improved.improvements).toHaveLength(4);
  });

  it("restricts comparison to the requested metrics", () => {
    const current = computeClassificationMetrics(poorPairs);
    const cmp = compareRuns(baseline, current, { metrics: ["f1"] });
    expect(cmp.deltas).toHaveLength(1);
    expect(cmp.deltas[0]?.metric).toBe("f1");
  });
});
