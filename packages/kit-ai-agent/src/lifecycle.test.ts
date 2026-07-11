/**
 * Lifecycle tests: plan → approve → execute → rollback（モックLLM＋インメモリストア）
 * 元テスト出典: tests/agentPlanner.test.ts / agent-approval.test.ts /
 *              agent-executor.test.ts / agent-rollback.test.ts（Supabaseモック→DIに置換）
 */
import { describe, expect, it, vi } from "vitest";
import { createApprovalService } from "./approval";
import { createExecutor, type ActionHandler } from "./executor";
import type { LlmCaller } from "./llm";
import { createPlanner, currentIsoWeek, type RawPlan } from "./planner";
import { createRollbackManager, createSnapshotRollback } from "./rollback";
import { createInMemoryExecutionLog, createInMemoryPlanStore } from "./stores";
import type { AuditEvent } from "./types";

function mockLlm(plan: RawPlan): LlmCaller {
  return {
    generateJson: async <T>(_s: string, _p: string, _f: T) => plan as unknown as T,
    generateText: async () => "text",
  };
}

const SAMPLE_PLAN: RawPlan = {
  objective: "Grow signups",
  actions: [
    {
      title: "Draft post",
      description: "Write a draft",
      action_type: "draft",
      risk_level: "low",
      approval_required: "none",
      rollback_strategy: { type: "delete", target_id: "ext-1" },
    },
    {
      title: "Publish post",
      description: "Publish it",
      action_type: "publish",
      risk_level: "high",
      approval_required: "slack",
      rollback_strategy: { type: "unpublish" },
    },
  ],
};

describe("planner", () => {
  it("persists a pending_approval plan with actions", async () => {
    const store = createInMemoryPlanStore();
    const planner = createPlanner({ llm: mockLlm(SAMPLE_PLAN), store });

    const { plan, actions } = await planner.generatePlan("t1");

    expect(plan.status).toBe("pending_approval");
    expect(plan.tenant_id).toBe("t1");
    expect(plan.plan_period).toBe(currentIsoWeek());
    expect(actions).toHaveLength(2);
    const stored = await store.listActionsByPlan(plan.id);
    expect(stored.every((a) => a.status === "pending_approval")).toBe(true);
  });

  it("normalizes an invalid risk_level to high", async () => {
    const store = createInMemoryPlanStore();
    const raw: RawPlan = {
      objective: "x",
      actions: [
        {
          title: "a",
          description: "b",
          action_type: "draft",
          risk_level: "extreme" as never,
          approval_required: "none",
        },
      ],
    };
    const planner = createPlanner({ llm: mockLlm(raw), store });
    const { plan } = await planner.generatePlan("t1");
    const [action] = await store.listActionsByPlan(plan.id);
    expect(action!.risk_level).toBe("high");
  });

  it("regenerateWithFeedback marks old plan revised and logs a decision", async () => {
    const store = createInMemoryPlanStore();
    const decisionLog = vi.fn();
    const planner = createPlanner({ llm: mockLlm(SAMPLE_PLAN), store, decisionLog });

    const first = await planner.generatePlan("t1");
    const second = await planner.regenerateWithFeedback({
      tenantId: "t1",
      planId: first.plan.id,
      feedback: "リスクを下げて",
    });

    expect((await store.getPlan(first.plan.id))!.status).toBe("revised");
    expect(second.plan.status).toBe("pending_approval");
    expect(second.plan.metadata).toMatchObject({ revised_from: first.plan.id });
    expect(decisionLog).toHaveBeenCalledWith(
      expect.objectContaining({ decisionType: "change", resourceId: second.plan.id }),
    );
  });

  it("throws plan_not_found for unknown plan feedback", async () => {
    const planner = createPlanner({ llm: mockLlm(SAMPLE_PLAN), store: createInMemoryPlanStore() });
    await expect(
      planner.regenerateWithFeedback({ tenantId: "t1", planId: "nope", feedback: "x" }),
    ).rejects.toThrow("plan_not_found");
  });
});

describe("approval", () => {
  async function setup() {
    const store = createInMemoryPlanStore();
    const planner = createPlanner({ llm: mockLlm(SAMPLE_PLAN), store });
    const { plan } = await planner.generatePlan("t1");
    const audit = vi.fn();
    const approval = createApprovalService({ store, audit });
    return { store, plan, audit, approval };
  }

  it("approvePlan auto-approves 'none' actions; source-scoped actions stay pending", async () => {
    const { store, plan, audit, approval } = await setup();
    await approval.approvePlan(plan.id, "u1", "dashboard");

    expect((await store.getPlan(plan.id))!.status).toBe("approved");
    const actions = await store.listActionsByPlan(plan.id);
    expect(actions.find((a) => a.approval_required === "none")!.status).toBe("approved");
    expect(actions.find((a) => a.approval_required === "slack")!.status).toBe("pending_approval");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent_plan_approved", resourceId: plan.id }),
    );
  });

  it("approvePlan approves matching-source actions", async () => {
    const { store, plan, approval } = await setup();
    await approval.approvePlan(plan.id, "u1", "slack");
    const actions = await store.listActionsByPlan(plan.id);
    expect(actions.every((a) => a.status === "approved")).toBe(true);
  });

  it("rejectPlan cancels pending actions and records the reason", async () => {
    const { store, plan, approval } = await setup();
    await approval.rejectPlan(plan.id, "u1", "dashboard", "too expensive");

    const updated = await store.getPlan(plan.id);
    expect(updated!.status).toBe("rejected");
    expect(updated!.rejection_reason).toBe("too expensive");
    const actions = await store.listActionsByPlan(plan.id);
    expect(actions.every((a) => a.status === "cancelled")).toBe(true);
  });

  it("approveAction approves an individual pending action", async () => {
    const { store, plan, approval } = await setup();
    await approval.approvePlan(plan.id, "u1", "dashboard");
    const pending = (await store.listActionsByPlan(plan.id)).find(
      (a) => a.status === "pending_approval",
    )!;
    await approval.approveAction(pending.id, "u2", "slack");
    expect((await store.getAction(pending.id))!.status).toBe("approved");
    expect((await store.getAction(pending.id))!.approval_ref).toBe("u2");
  });

  it("throws when the plan is not pending", async () => {
    const { plan, approval } = await setup();
    await approval.approvePlan(plan.id, "u1", "dashboard");
    await expect(approval.approvePlan(plan.id, "u1", "dashboard")).rejects.toThrow(
      "plan_not_pending",
    );
  });
});

describe("executor", () => {
  async function setupApproved(handlers: Record<string, ActionHandler>) {
    const store = createInMemoryPlanStore();
    const executionLog = createInMemoryExecutionLog();
    const planner = createPlanner({ llm: mockLlm(SAMPLE_PLAN), store });
    const { plan } = await planner.generatePlan("t1");
    await createApprovalService({ store }).approvePlan(plan.id, "u1", "slack");
    const actions = await store.listActionsByPlan(plan.id);
    return { store, executionLog, actions, handlers };
  }

  it("executes an approved action and records the execution log", async () => {
    const handler = vi.fn(async () => ({ externalId: "ext-9", cost: 3 }));
    const { store, executionLog, actions } = await setupApproved({ draft: handler });
    const target = actions.find((a) => a.action_type === "draft")!;

    const executor = createExecutor({ store, handlers: { draft: handler }, executionLog });
    const outcome = await executor.executeAction(target.id);

    expect(outcome).toEqual({ status: "completed", externalId: "ext-9", cost: 3 });
    expect((await store.getAction(target.id))!.status).toBe("completed");
    expect(executionLog.entries).toHaveLength(1);
    expect(executionLog.entries[0]).toMatchObject({ result: "success", external_id: "ext-9" });
  });

  it("cancels when the budget guard rejects", async () => {
    const { store, actions } = await setupApproved({});
    const target = actions[0]!;
    const executor = createExecutor({
      store,
      handlers: {},
      budget: {
        estimateCost: () => 100,
        getRemaining: async () => 10,
        addUsage: vi.fn(),
      },
    });
    const outcome = await executor.executeAction(target.id);
    expect(outcome).toEqual({ status: "cancelled", reason: "budget_exceeded" });
    expect((await store.getAction(target.id))!.status).toBe("cancelled");
  });

  it("cancels when the pre-execution policy check fails", async () => {
    const { store, actions } = await setupApproved({});
    const target = actions[0]!;
    const executor = createExecutor({
      store,
      handlers: {},
      preExecutionCheck: async () => ({ ok: false, reason: "compliance_risk" }),
    });
    const outcome = await executor.executeAction(target.id);
    expect(outcome).toEqual({ status: "cancelled", reason: "compliance_risk" });
  });

  it("fails the action on unknown action_type", async () => {
    const { store, actions } = await setupApproved({});
    const target = actions[0]!;
    const executor = createExecutor({ store, handlers: {} });
    await expect(executor.executeAction(target.id)).rejects.toThrow("unknown_action_type");
    expect((await store.getAction(target.id))!.status).toBe("failed");
  });

  it("marks failed and logs when the handler throws", async () => {
    const executionLog = createInMemoryExecutionLog();
    const { store, actions } = await setupApproved({});
    const target = actions.find((a) => a.action_type === "draft")!;
    const executor = createExecutor({
      store,
      executionLog,
      handlers: { draft: async () => Promise.reject(new Error("boom")) },
    });
    const outcome = await executor.executeAction(target.id);
    expect(outcome).toEqual({ status: "failed", error: "boom" });
    expect((await store.getAction(target.id))!.status).toBe("failed");
    expect(executionLog.entries[0]).toMatchObject({ result: "failure", error_message: "boom" });
  });

  it("throws when the action is not approved", async () => {
    const store = createInMemoryPlanStore();
    const planner = createPlanner({ llm: mockLlm(SAMPLE_PLAN), store });
    const { plan } = await planner.generatePlan("t1");
    const [action] = await store.listActionsByPlan(plan.id);
    const executor = createExecutor({ store, handlers: {} });
    await expect(executor.executeAction(action!.id)).rejects.toThrow("action_not_approved");
  });
});

describe("rollback", () => {
  it("rolls back a completed action via the strategy handler", async () => {
    const store = createInMemoryPlanStore();
    const [action] = await store.insertActions([
      {
        tenant_id: "t1",
        plan_id: "p1",
        title: "a",
        description: "b",
        action_type: "draft",
        risk_level: "low",
        approval_required: "none",
        status: "completed",
        rollback_strategy: { type: "delete", target_id: "ext-1" },
      },
    ]);
    const handler = vi.fn(async () => {});
    const audit = vi.fn();
    const manager = createRollbackManager({ store, handlers: { delete: handler }, audit });

    await manager.rollbackAction(action!.id, "ops@example.com");

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: action!.id }),
      expect.objectContaining({ type: "delete", target_id: "ext-1" }),
    );
    expect((await store.getAction(action!.id))!.status).toBe("rolled_back");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent_action_rolled_back", actor: "ops@example.com" }),
    );
  });

  it("rejects non-completed actions and unknown strategies", async () => {
    const store = createInMemoryPlanStore();
    const [pending, done] = await store.insertActions([
      {
        tenant_id: "t1",
        plan_id: "p1",
        title: "a",
        description: "b",
        action_type: "draft",
        risk_level: "low",
        approval_required: "none",
        status: "pending_approval",
        rollback_strategy: { type: "delete" },
      },
      {
        tenant_id: "t1",
        plan_id: "p1",
        title: "c",
        description: "d",
        action_type: "draft",
        risk_level: "low",
        approval_required: "none",
        status: "completed",
        rollback_strategy: { type: "warp" },
      },
    ]);
    const manager = createRollbackManager({ store, handlers: {} });
    await expect(manager.rollbackAction(pending!.id, "u")).rejects.toThrow(
      "only_completed_actions_can_rollback",
    );
    await expect(manager.rollbackAction(done!.id, "u")).rejects.toThrow(
      "unknown_rollback_strategy: warp",
    );
  });

  it("snapshot rollback captures then restores", async () => {
    const provider = {
      capture: vi.fn(async () => "snap-1"),
      restore: vi.fn(async () => 42),
    };
    const sr = createSnapshotRollback(provider);
    const key = await sr.prepareDeployment("t1", "d1");
    expect(key).toBe("snap-1");
    const result = await sr.executeRollback("t1", "d1", key);
    expect(result).toEqual({ restored: 42 });
    expect(provider.restore).toHaveBeenCalledWith("t1", "snap-1");
  });
});

describe("end-to-end lifecycle", () => {
  it("plan → approve → execute → rollback with mock LLM and tools", async () => {
    const store = createInMemoryPlanStore();
    const executionLog = createInMemoryExecutionLog();
    const auditTrail: AuditEvent[] = [];
    const audit = (e: AuditEvent) => {
      auditTrail.push(e);
    };

    // 1. Plan (mock LLM)
    const planner = createPlanner({ llm: mockLlm(SAMPLE_PLAN), store });
    const { plan } = await planner.generatePlan("t1");
    expect(plan.status).toBe("pending_approval");

    // 2. Approve (slack source approves everything in this plan)
    await createApprovalService({ store, audit }).approvePlan(plan.id, "boss", "slack");

    // 3. Execute all approved actions
    const deleted: string[] = [];
    const executor = createExecutor({
      store,
      executionLog,
      audit,
      handlers: {
        draft: async () => ({ externalId: "draft-1", cost: 0.05 }),
        publish: async () => ({ externalId: "post-1", cost: 0 }),
      },
    });
    for (const a of await store.listActionsByPlan(plan.id)) {
      const outcome = await executor.executeAction(a.id);
      expect(outcome.status).toBe("completed");
    }
    expect(executionLog.entries).toHaveLength(2);

    // 4. Roll back the published action
    const published = (await store.listActionsByPlan(plan.id)).find(
      (a) => a.action_type === "publish",
    )!;
    const manager = createRollbackManager({
      store,
      audit,
      handlers: {
        unpublish: async (action) => {
          deleted.push(action.id);
        },
      },
    });
    await manager.rollbackAction(published.id, "boss");

    expect(deleted).toEqual([published.id]);
    expect((await store.getAction(published.id))!.status).toBe("rolled_back");
    expect(auditTrail.map((e) => e.action)).toEqual([
      "agent_plan_approved",
      "agent_action_completed",
      "agent_action_completed",
      "agent_action_rolled_back",
    ]);
  });
});
