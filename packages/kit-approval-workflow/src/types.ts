/**
 * Core types for the approval workflow kit (申請→リスク評価→承認→監査).
 *
 * Ported from 実運用SaaS:
 *   - server/routes/firewall/submit.ts / decision.ts (submission lifecycle)
 *   - supabase/migrations/20260421100000_g9_s3_firewall_foundation.sql (dd_submissions)
 *   - supabase/migrations/202604210002_g9_s4_active_learning_foundation.sql (dd_exception_requests)
 *   - supabase/migrations/202604200009_g9_s1_why_foundation.sql (dd_decision_log)
 *
 * Table prefixes (dd_) and product-specific columns (brand DNA snapshot, CPA
 * simulation, challenger proposals, ...) are dropped; the generic core remains.
 */

/**
 * Submission state machine (original #1018 semantics):
 *
 *   draft → submitted → (evaluate)
 *     riskScore > 0   → "lint_running"  (evaluation flagged; submitter fixes & reapplies)
 *     riskScore === 0 → "under_review"  (passed evaluation, awaiting human approval)
 *   under_review → approved | rejected | override (exception request filed)
 *   approved → deployed (optional post-approval action)
 */
export type SubmissionStatus =
  | "draft"
  | "submitted"
  | "lint_running"
  | "lint_failed"
  | "under_review"
  | "approved"
  | "rejected"
  | "override"
  | "deployed";

export interface Submission {
  id: string;
  tenantId: string;
  /** 起案者 */
  submitterId: string;
  /** 承認者 (nullable until assigned / escalated) */
  approverId: string | null;
  title: string;
  contentText: string;
  creativeUrls: string[];
  status: SubmissionStatus;
  /** Loose reference to the risk-evaluation record (original: firewall_check_id). */
  checkId: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  /** Dynamic-triage rejection code chosen by the approver. */
  rejectionReasonCode: string | null;
  rejectionReasonText: string | null;
  /** Reference to the exception request that overrides this submission. */
  overrideExceptionId: string | null;
  /** Free-form flags (e.g. { escalated: true } set by the escalation job). */
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Result of the injected risk evaluator (original: compliance checker output). */
export interface RiskEvaluation {
  checkId: string;
  /** 0 = clean; > 0 = flagged. */
  riskScore: number;
  violations: unknown[];
  summary?: string;
}

export type DecisionAction = "approve" | "reject" | "override" | "deploy";

/**
 * Exception request (稟議 / ringi): a submitter's structured appeal against a
 * rejection, decided by a senior approver (original: CMO).
 */
export interface ExceptionRequest {
  id: string;
  tenantId: string;
  originalSubmissionId: string | null;
  rejectedContent: string;
  rejectionReason: string;
  submitterOverrideArgument: string;
  decision: "approved" | "rejected" | null;
  decisionAt: string | null;
  decisionReasoning: string | null;
  createdAt: string;
}

/**
 * Audit entry, mirroring the generic columns of dd_decision_log.
 * Persisting it is delegated to the injected {@link AuditLogger}.
 */
export interface AuditEntry {
  tenantId: string;
  decisionType: "start" | "stop" | "change" | "approval" | "rejection";
  subject: string;
  context: string;
  reason: string | null;
  source: "manual" | "slack" | "system" | "ai_suggestion";
  decidedBy: string | null;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/** Injected audit sink. Failures should be handled by the implementation. */
export type AuditLogger = (entry: AuditEntry) => void | Promise<void>;

/** Dynamic-triage rejection option shown in the Slack reject modal. */
export interface TriageOption {
  code: string;
  label: string;
}
