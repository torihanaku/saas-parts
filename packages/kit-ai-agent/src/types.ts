/**
 * Core domain types for the plan → approve → execute → rollback lifecycle.
 *
 * 出典: dev-dashboard-v2 server/services/agentPlanner.ts /
 *       server/lib/agent/{approval-service,executor,rollback-service}.ts
 * （Supabase テーブル dd_agent_plans / dd_agent_actions / dd_agent_executions を
 *   ストアインターフェースとして抽象化）
 */

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type PlanStatus = "pending_approval" | "approved" | "rejected" | "revised";

export type ActionStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "cancelled"
  | "executing"
  | "completed"
  | "failed"
  | "rolled_back";

/**
 * Approval source. "none" means auto-approved with the plan.
 * Any other string (e.g. "dashboard", "slack", "cli") is matched against the
 * source that approved the plan — actions requiring a different source stay
 * pending and must be approved individually.
 */
export type ApprovalRequirement = "none" | (string & {});

export interface RollbackStrategy {
  /** e.g. "delete" | "unpublish" | "revert" | "cancel" — dispatched via injected handlers */
  type: string;
  target_id?: string;
  [key: string]: unknown;
}

export interface PlanActionInput {
  title: string;
  description: string;
  /** Free-form routing key for the execution handler registry (元: action_type/channel). */
  action_type: string;
  risk_level: RiskLevel;
  approval_required: ApprovalRequirement;
  payload?: Record<string, unknown>;
  rollback_strategy?: RollbackStrategy | null;
}

export interface AgentPlan {
  id: string;
  tenant_id: string;
  /** Period key, e.g. ISO week "2026-W28" (元: plan_week). */
  plan_period: string;
  objective: string;
  status: PlanStatus;
  approved_by?: string | null;
  approved_at?: string | null;
  rejection_reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AgentAction extends PlanActionInput {
  id: string;
  tenant_id: string;
  plan_id: string;
  status: ActionStatus;
  approved_at?: string | null;
  /** Approver reference (user id, webhook message ts, ...). */
  approval_ref?: string | null;
}

export interface ExecutionRecord {
  tenant_id: string;
  action_id: string;
  executor: string;
  result: "success" | "failure" | "timeout";
  external_id?: string;
  error_message?: string;
  audit_hash?: string;
}

// ─── Injected stores ─────────────────────────────────────────────────────────

export interface PlanStore {
  insertPlan(plan: Omit<AgentPlan, "id">): Promise<AgentPlan>;
  getPlan(planId: string): Promise<AgentPlan | null>;
  updatePlan(planId: string, patch: Partial<AgentPlan>): Promise<void>;

  insertActions(
    actions: Array<Omit<AgentAction, "id">>,
  ): Promise<AgentAction[]>;
  getAction(actionId: string): Promise<AgentAction | null>;
  listActionsByPlan(planId: string): Promise<AgentAction[]>;
  updateAction(actionId: string, patch: Partial<AgentAction>): Promise<void>;
}

/** Execution audit trail (元: dd_agent_executions). */
export interface ExecutionLogStore {
  record(entry: ExecutionRecord): Promise<void>;
}

// ─── Injected audit hook ─────────────────────────────────────────────────────

export interface AuditEvent {
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  riskLevel: RiskLevel;
  changes?: Record<string, unknown>;
  /** "human" | "slack_user" | "system" | ... */
  actorType?: string;
  actor?: string;
}

/** May return a hash (audit hash-chain integration point); return value is optional. */
export type AuditLogger = (event: AuditEvent) => Promise<string | void> | string | void;
