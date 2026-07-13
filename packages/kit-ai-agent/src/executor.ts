/**
 * Action executor: runs an *approved* action through guard rails
 * (budget → pre-execution policy check → handler dispatch), records the
 * outcome to the execution log, and moves status through
 * approved → executing → completed | failed | cancelled.
 *
 * 出典: 実運用SaaS server/lib/agent/executor.ts
 * 変更点: Supabase 直結 → PlanStore/ExecutionLogStore 注入 /
 *         製品ハンドラー (blog/sns/email/ad) → ActionHandler レジストリ注入 /
 *         compliance チェック → preExecutionCheck ポリシー注入 /
 *         テナント予算テーブル → BudgetGuard 注入。
 */
import type {
  AgentAction,
  AuditLogger,
  ExecutionLogStore,
  PlanStore,
} from "./types";

export interface ExecuteResult {
  externalId: string;
  cost: number;
}

export type ActionHandler = (action: AgentAction) => Promise<ExecuteResult>;

/** Monthly (or arbitrary window) budget guard. 元: dd_agent_tenant_settings. */
export interface BudgetGuard {
  /** Expected cost of the action before running it. */
  estimateCost(action: AgentAction): number | Promise<number>;
  /** Remaining budget for the tenant. */
  getRemaining(tenantId: string): Promise<number>;
  /** Record consumed budget after a successful run. */
  addUsage(tenantId: string, cost: number): Promise<void>;
}

/** Pre-execution policy check (元: compliance checker → riskScore>50 で cancel). */
export type PreExecutionCheck = (
  action: AgentAction,
) => Promise<{ ok: boolean; reason?: string; detail?: Record<string, unknown> }>;

export interface ExecutorConfig {
  store: PlanStore;
  /** action_type → handler. Unknown types fail the action. */
  handlers: Record<string, ActionHandler>;
  budget?: BudgetGuard;
  preExecutionCheck?: PreExecutionCheck;
  executionLog?: ExecutionLogStore;
  audit?: AuditLogger;
  /** Recorded in the execution log as the executor identity (default "system"). */
  executorId?: string;
}

export type ExecutionOutcome =
  | { status: "completed"; externalId: string; cost: number }
  | { status: "cancelled"; reason: string }
  | { status: "failed"; error: string };

export interface Executor {
  executeAction(actionId: string): Promise<ExecutionOutcome>;
}

export function createExecutor(config: ExecutorConfig): Executor {
  const executorId = config.executorId ?? "system";

  return {
    async executeAction(actionId) {
      const action = await config.store.getAction(actionId);
      if (!action || action.status !== "approved") throw new Error("action_not_approved");

      // 1. Budget guard
      if (config.budget) {
        const expectedCost = await config.budget.estimateCost(action);
        const remaining = await config.budget.getRemaining(action.tenant_id);
        if (expectedCost > remaining) {
          await config.store.updateAction(actionId, { status: "cancelled" });
          await config.audit?.({
            tenantId: action.tenant_id,
            action: "agent_action_cancelled",
            resourceType: "agent_action",
            resourceId: actionId,
            riskLevel: "critical",
            changes: {
              status: "cancelled",
              reason: "budget_exceeded",
              expected_cost: expectedCost,
              remaining,
            },
          });
          return { status: "cancelled", reason: "budget_exceeded" };
        }
      }

      // 2. Pre-execution policy check (compliance / brand-safety / anything)
      if (config.preExecutionCheck) {
        const check = await config.preExecutionCheck(action);
        if (!check.ok) {
          const reason = check.reason ?? "policy_check_failed";
          await config.store.updateAction(actionId, { status: "cancelled" });
          await config.audit?.({
            tenantId: action.tenant_id,
            action: "agent_action_cancelled",
            resourceType: "agent_action",
            resourceId: actionId,
            riskLevel: "high",
            changes: { status: "cancelled", reason, ...check.detail },
          });
          return { status: "cancelled", reason };
        }
      }

      // 3. Dispatch
      await config.store.updateAction(actionId, { status: "executing" });

      const handler = config.handlers[action.action_type];
      if (!handler) {
        await config.store.updateAction(actionId, { status: "failed" });
        throw new Error(`unknown_action_type: ${action.action_type}`);
      }

      try {
        const result = await handler(action);
        const auditHash = await config.audit?.({
          tenantId: action.tenant_id,
          action: "agent_action_completed",
          resourceType: "agent_action",
          resourceId: actionId,
          riskLevel: "low",
          changes: { status: "completed", external_id: result.externalId, cost: result.cost },
        });
        await config.executionLog?.record({
          tenant_id: action.tenant_id,
          action_id: actionId,
          executor: executorId,
          result: "success",
          external_id: result.externalId,
          ...(typeof auditHash === "string" ? { audit_hash: auditHash } : {}),
        });
        await config.store.updateAction(actionId, { status: "completed" });
        if (config.budget && result.cost > 0) {
          await config.budget.addUsage(action.tenant_id, result.cost);
        }
        return { status: "completed", externalId: result.externalId, cost: result.cost };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        await config.executionLog?.record({
          tenant_id: action.tenant_id,
          action_id: actionId,
          executor: executorId,
          result: "failure",
          error_message: msg,
        });
        await config.store.updateAction(actionId, { status: "failed" });
        await config.audit?.({
          tenantId: action.tenant_id,
          action: "agent_action_failed",
          resourceType: "agent_action",
          resourceId: actionId,
          riskLevel: "high",
          changes: { status: "failed", error: msg },
        });
        return { status: "failed", error: msg };
      }
    },
  };
}
