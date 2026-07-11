/**
 * 運用系（monitor / auto-rollback / cost-tracker / report / evidence）のテスト。
 * 元テスト出典: tests/agent-monitor.test.ts / auto-rollback（同名） /
 *              agent-report.test.ts / tests/server/services/evidence-agent.test.ts
 *              （Supabase/gcloud/Slack モック → DI に置換）
 */
import { describe, expect, it, vi } from "vitest";
import { createAutoRollback } from "./auto-rollback";
import { CostTracker } from "./cost-tracker";
import { createEvidenceAgent } from "./evidence";
import type { LlmCaller } from "./llm";
import { createMonitor, type AnomalyEvent } from "./monitor";
import { createReporter } from "./report";
import {
  createInMemoryAnomalyStore,
  createInMemoryCostStore,
  createInMemoryExecutionLog,
  createInMemoryPlanStore,
} from "./stores";

function anomaly(over: Partial<AnomalyEvent> = {}): AnomalyEvent {
  return {
    tenantId: "t1",
    type: "cpa_spike",
    severity: "critical",
    metrics: { recentCpa: 900, baselineCpa: 300 },
    detectedAt: new Date().toISOString(),
    ...over,
  };
}

describe("monitor", () => {
  it("collects events from all detectors, persists and notifies", async () => {
    const store = createInMemoryPlanStore();
    const anomalyStore = createInMemoryAnomalyStore();
    const notify = vi.fn();
    const monitor = createMonitor({
      detectors: [async () => [anomaly()], async () => [anomaly({ type: "seo_rank_drop" })]],
      store,
      anomalyStore,
      notify,
    });

    const events = await monitor.runMonitoringCycle("t1");
    expect(events).toHaveLength(2);
    expect(anomalyStore.events).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("halts the target action on autoAction=halt and audits critically", async () => {
    const store = createInMemoryPlanStore();
    const [action] = await store.insertActions([
      {
        tenant_id: "t1",
        plan_id: "p1",
        title: "a",
        description: "b",
        action_type: "ad_budget_change",
        risk_level: "high",
        approval_required: "none",
        status: "executing",
      },
    ]);
    const audit = vi.fn();
    const monitor = createMonitor({
      detectors: [async () => [anomaly({ autoAction: "halt", targetActionId: action!.id })]],
      store,
      audit,
    });

    await monitor.runMonitoringCycle("t1");
    expect((await store.getAction(action!.id))!.status).toBe("cancelled");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent_auto_halt", riskLevel: "critical" }),
    );
  });

  it("isolates detector failures", async () => {
    const onError = vi.fn();
    const monitor = createMonitor({
      detectors: [
        async () => Promise.reject(new Error("detector down")),
        async () => [anomaly()],
      ],
      store: createInMemoryPlanStore(),
      onError,
    });
    const events = await monitor.runMonitoringCycle("t1");
    expect(events).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith("agent.monitor", expect.any(Error));
  });
});

describe("auto-rollback", () => {
  function makeRollbacker(prev: string | null = "rev-1") {
    return {
      getPreviousRevision: vi.fn(async () => prev ?? undefined),
      rollback: vi.fn(async () => ({ ok: true })),
    };
  }

  it("skips when the kill switch is off", async () => {
    const rollbacker = makeRollbacker();
    const ar = createAutoRollback({ isEnabled: () => false, rollbacker });
    const res = await ar.checkAndRollback({ tenantId: "t1", violationRules: ["error_rate"], service: "svc" });
    expect(res).toMatchObject({ skipped: true, skipReason: "kill_switch" });
    expect(rollbacker.rollback).not.toHaveBeenCalled();
  });

  it("waits for the threshold, then triggers exactly once", async () => {
    let now = new Date("2026-07-11T00:00:00Z");
    const rollbacker = makeRollbacker();
    const executionLog = createInMemoryExecutionLog();
    const ar = createAutoRollback({
      isEnabled: () => true,
      rollbacker,
      executionLog,
      now: () => now,
    });
    const input = { tenantId: "t1", violationRules: ["error_rate"], service: "svc" };

    // first sighting → below threshold
    expect(await ar.checkAndRollback(input)).toMatchObject({
      skipped: true,
      skipReason: "violation_below_threshold",
    });

    // 31 s later → trigger
    now = new Date(now.getTime() + 31_000);
    const res = await ar.checkAndRollback(input);
    expect(res).toMatchObject({ triggered: true });
    expect(rollbacker.rollback).toHaveBeenCalledWith(
      expect.objectContaining({ service: "svc", revision: "rev-1", dryRun: false }),
    );
    expect(executionLog.entries[0]).toMatchObject({
      executor: "auto_rollback",
      result: "success",
      external_id: "svc@rev-1",
    });

    // still firing → no repeat rollback
    now = new Date(now.getTime() + 60_000);
    expect(await ar.checkAndRollback(input)).toMatchObject({
      skipped: true,
      skipReason: "violation_below_threshold",
    });
    expect(rollbacker.rollback).toHaveBeenCalledTimes(1);
  });

  it("clears state when the violation recovers (clock resets)", async () => {
    let now = new Date("2026-07-11T00:00:00Z");
    const rollbacker = makeRollbacker();
    const ar = createAutoRollback({ isEnabled: () => true, rollbacker, now: () => now });

    await ar.checkAndRollback({ tenantId: "t1", violationRules: ["error_rate"], service: "svc" });
    // recovered
    await ar.checkAndRollback({ tenantId: "t1", violationRules: [], service: "svc" });
    // re-fires 40 s later — clock must have reset, so still below threshold
    now = new Date(now.getTime() + 40_000);
    const res = await ar.checkAndRollback({ tenantId: "t1", violationRules: ["error_rate"], service: "svc" });
    expect(res).toMatchObject({ skipped: true, skipReason: "violation_below_threshold" });
  });

  it("skips when no previous revision exists", async () => {
    let now = new Date("2026-07-11T00:00:00Z");
    const ar = createAutoRollback({
      isEnabled: () => true,
      rollbacker: makeRollbacker(null),
      now: () => now,
    });
    const input = { tenantId: "t1", violationRules: ["latency"], service: "svc" };
    await ar.checkAndRollback(input);
    now = new Date(now.getTime() + 31_000);
    expect(await ar.checkAndRollback(input)).toMatchObject({
      skipped: true,
      skipReason: "no_previous_revision",
    });
  });
});

describe("cost-tracker", () => {
  it("snapshots LLM + API + labor costs with the default pricing", () => {
    const tracker = new CostTracker({ runId: "r1", tenantId: "t1" });
    tracker.recordLlmUsage({ inputTokens: 2000, outputTokens: 1000 });
    tracker.recordApiCall("wordpress");
    tracker.recordApiCall("unknown_platform");

    const snap = tracker.snapshot({ laborHours: 0.5 });
    expect(snap.llmCost).toBeCloseTo(2 * 0.45 + 1 * 2.25);
    expect(snap.apiCost).toBeCloseTo(1.0); // 0.5 + 0.5 (default rate)
    expect(snap.laborEquivalent).toBe(3000);
    expect(snap.totalCost).toBeCloseTo(snap.llmCost + snap.apiCost + snap.laborEquivalent);
  });

  it("persists per-step records idempotently with a baseline comparison", async () => {
    const store = createInMemoryCostStore();
    const tracker = new CostTracker({
      runId: "r1",
      tenantId: "t1",
      store,
      pricing: { apiCallByPlatform: { google_ads: 1.5 } },
    });
    tracker.recordApiCall("google_ads");

    const rec = await tracker.persist({ stepId: "dist", laborHours: 1 });
    expect(rec.cost).toBeCloseTo(1.5 + 6000);
    expect(rec.details.cost_comparison).toMatchObject({ baseline: 45_000 });
    // idempotent upsert on (runId, stepId)
    await tracker.persist({ stepId: "dist", laborHours: 1 });
    expect(store.records.size).toBe(1);
  });

  it("reset clears accumulators between steps", () => {
    const tracker = new CostTracker({ runId: "r1", tenantId: "t1" });
    tracker.recordLlmUsage({ inputTokens: 1000, outputTokens: 0 });
    tracker.reset();
    expect(tracker.snapshot().totalCost).toBe(0);
  });
});

describe("report", () => {
  const llm = (impl: (system: string, prompt: string) => Promise<string>): LlmCaller => ({
    generateJson: vi.fn(),
    generateText: vi.fn(impl),
  });

  it("returns a no-plan message when the cycle has no plan", async () => {
    const reporter = createReporter({
      llm: llm(async () => "x"),
      loadCycle: async () => ({ plan: null, actions: [], executions: [] }),
    });
    expect(await reporter.generateCycleReport("t1", "2026-W28")).toContain("2026-W28");
  });

  it("feeds success/failure counts and action summaries into the prompt", async () => {
    let captured = "";
    const reporter = createReporter({
      llm: llm(async (_s, p) => {
        captured = p;
        return "レポート本文";
      }),
      loadCycle: async () => ({
        plan: {
          id: "p1",
          tenant_id: "t1",
          plan_period: "2026-W28",
          objective: "obj",
          status: "approved",
        },
        actions: [
          {
            id: "a1",
            tenant_id: "t1",
            plan_id: "p1",
            title: "t",
            description: "d",
            action_type: "sns_post",
            risk_level: "low",
            approval_required: "none",
            status: "completed",
            payload: { text: "hello" },
          },
        ],
        executions: [{ result: "success" }, { result: "failure" }, { result: "success" }],
      }),
    });

    const text = await reporter.generateCycleReport("t1", "2026-W28");
    expect(text).toBe("レポート本文");
    expect(captured).toContain("成功 2 / 失敗 1");
    expect(captured).toContain("sns_post");
  });

  it("uses the executive prompt for the executive audience and reports LLM errors as text", async () => {
    const generateText = vi.fn(async (_s: string, _p: string): Promise<string> => {
      throw new Error("llm down");
    });
    const reporter = createReporter({
      llm: { generateJson: vi.fn(), generateText },
      loadCycle: async () => ({
        plan: {
          id: "p1",
          tenant_id: "t1",
          plan_period: "w",
          objective: "o",
          status: "approved",
        },
        actions: [],
        executions: [],
      }),
    });
    const text = await reporter.generateCycleReport("t1", "w", "executive");
    expect(generateText.mock.calls[0]![0]).toContain("経営陣");
    expect(text).toContain("llm down");
  });
});

describe("evidence", () => {
  it("gathers from all sources in parallel, keyed by source name", async () => {
    const decisionLog = vi.fn();
    const agent = createEvidenceAgent({
      loadSubject: async () => ({ title: "値引き例外" }),
      decisionLog,
      sources: [
        {
          name: "pastCases",
          fetch: async (q) => [
            { title: q.subjectTitle, summary: "過去に承認", source: "Institutional Memory", confidence: 0.8 },
          ],
        },
        { name: "legal", fetch: async () => [] },
      ],
    });

    const result = await agent.gather("t1", "sub-1");
    expect(Object.keys(result)).toEqual(["pastCases", "legal"]);
    expect(result.pastCases![0]!.title).toBe("値引き例外");
    expect(decisionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "sub-1",
        metadata: expect.objectContaining({
          result_summary: { pastCases_count: 1, legal_count: 0 },
        }),
      }),
    );
  });

  it("throws subject_not_found for unknown subjects", async () => {
    const agent = createEvidenceAgent({
      loadSubject: async () => null,
      sources: [],
    });
    await expect(agent.gather("t1", "nope")).rejects.toThrow("subject_not_found");
  });
});
