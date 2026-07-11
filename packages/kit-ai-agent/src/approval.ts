/**
 * Approval gate: human sign-off between plan generation and execution.
 *
 * - Plan approval auto-approves actions whose `approval_required` is "none"
 *   or matches the approving source; anything else stays pending and needs
 *   an individual `approveAction` (元実装の high-risk 二段承認と同じ挙動).
 * - Rejection cancels all still-pending actions.
 *
 * 出典: dev-dashboard-v2 server/lib/agent/approval-service.ts
 * 変更点: Supabase 直結 → PlanStore 注入 / logAuditSystem → AuditLogger 注入 /
 *         Slack 通知 → ApprovalNotifier 注入（省略可）。
 */
import type { AuditLogger, PlanStore } from "./types";

export interface ApprovalNotifier {
  approved?(planId: string): Promise<void> | void;
  rejected?(planId: string, reason: string): Promise<void> | void;
}

export interface ApprovalServiceConfig {
  store: PlanStore;
  audit?: AuditLogger;
  notify?: ApprovalNotifier;
}

export interface ApprovalService {
  approvePlan(planId: string, approver: string, source: string): Promise<void>;
  rejectPlan(planId: string, approver: string, source: string, reason: string): Promise<void>;
  approveAction(actionId: string, approver: string, source: string): Promise<void>;
  rejectAction(actionId: string, approver: string, source: string): Promise<void>;
}

export function createApprovalService(config: ApprovalServiceConfig): ApprovalService {
  const { store, audit, notify } = config;

  return {
    async approvePlan(planId, approver, source) {
      const plan = await store.getPlan(planId);
      if (!plan || plan.status !== "pending_approval") throw new Error("plan_not_pending");

      await store.updatePlan(planId, {
        status: "approved",
        approved_by: approver,
        approved_at: new Date().toISOString(),
      });

      const actions = await store.listActionsByPlan(planId);
      for (const a of actions) {
        if (a.approval_required === "none" || a.approval_required === source) {
          await store.updateAction(a.id, {
            status: "approved",
            approved_at: new Date().toISOString(),
            approval_ref: approver,
          });
        }
        // それ以外（別ソースの追加承認が必要なもの）は pending のまま →
        // 個別に approveAction() で承認する。
      }

      await audit?.({
        tenantId: plan.tenant_id,
        action: "agent_plan_approved",
        resourceType: "agent_plan",
        resourceId: planId,
        changes: { status: "approved", source, approver },
        actorType: "human",
        riskLevel: "medium",
      });
      await notify?.approved?.(planId);
    },

    async rejectPlan(planId, approver, source, reason) {
      const plan = await store.getPlan(planId);
      if (!plan || plan.status !== "pending_approval") throw new Error("plan_not_pending");

      await store.updatePlan(planId, { status: "rejected", rejection_reason: reason });

      const actions = await store.listActionsByPlan(planId);
      for (const a of actions) {
        if (a.status === "pending_approval") {
          await store.updateAction(a.id, { status: "cancelled" });
        }
      }

      await audit?.({
        tenantId: plan.tenant_id,
        action: "agent_plan_rejected",
        resourceType: "agent_plan",
        resourceId: planId,
        changes: { status: "rejected", reason, source, approver },
        actorType: "human",
        riskLevel: "low",
      });
      await notify?.rejected?.(planId, reason);
    },

    async approveAction(actionId, approver, source) {
      const action = await store.getAction(actionId);
      if (!action || action.status !== "pending_approval") throw new Error("action_not_pending");

      await store.updateAction(actionId, {
        status: "approved",
        approved_at: new Date().toISOString(),
        approval_ref: approver,
      });

      await audit?.({
        tenantId: action.tenant_id,
        action: "agent_action_approved",
        resourceType: "agent_action",
        resourceId: actionId,
        changes: { status: "approved", source, approver },
        actorType: "human",
        riskLevel: action.risk_level,
      });
    },

    async rejectAction(actionId, approver, source) {
      const action = await store.getAction(actionId);
      if (!action || action.status !== "pending_approval") throw new Error("action_not_pending");

      await store.updateAction(actionId, { status: "rejected" });

      await audit?.({
        tenantId: action.tenant_id,
        action: "agent_action_rejected",
        resourceType: "agent_action",
        resourceId: actionId,
        changes: { status: "rejected", source, approver },
        actorType: "human",
        riskLevel: "low",
      });
    },
  };
}
