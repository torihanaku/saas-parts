/**
 * Approval workflow core: submission lifecycle
 * (submit → evaluate → pending → approve/reject → audit) plus the
 * exception-request (稟議 / ringi) escape hatch.
 *
 * Ported from 実運用SaaS:
 *   - server/routes/firewall/submit.ts     (submit + evaluate + status machine)
 *   - server/routes/firewall/decision.ts   (dashboard decision)
 *   - server/routes/firewall/reapply.ts    (quick-fix reapply + re-evaluate)
 *   - server/routes/firewall/slack-actions.ts (recordApprove / recordReject)
 *   - server/routes/firewall/exception.ts, server/routes/ringi/{submit,approve}.ts
 *
 * All I/O goes through injected ports: stores, risk evaluator, notifier,
 * audit logger, and optional post-decision hooks. No env vars, no vendor SDKs.
 */
import type {
  AuditLogger,
  DecisionAction,
  ExceptionRequest,
  RiskEvaluation,
  Submission,
  SubmissionStatus,
} from "./types.js";
import type { ExceptionRequestStore, SubmissionStore } from "./stores.js";

/** Injected risk evaluator (original: compliance lint checker). */
export type RiskEvaluator = (input: {
  tenantId: string;
  contentText: string;
}) => Promise<RiskEvaluation>;

/** Injected approver notification (original: Slack DM Block Kit message). */
export type ApproverNotifier = (
  submission: Submission,
  evaluation: RiskEvaluation,
) => Promise<void>;

export interface ApprovalWorkflowDeps {
  submissions: SubmissionStore;
  exceptions: ExceptionRequestStore;
  evaluate: RiskEvaluator;
  /** Called after a submission enters review (and after escalation-style reassignments). */
  notifyApprover?: ApproverNotifier;
  /** Audit sink (original: dd_decision_log insert). */
  audit?: AuditLogger;
  /**
   * Best-effort hook after a submission is approved
   * (original: deploy-gate dispatch / DNA ingestion). Errors are swallowed.
   */
  onApproved?: (submission: Submission) => Promise<void> | void;
  /**
   * Best-effort hook after a submission is rejected
   * (original: hard-negatives training-data pipeline). Errors are swallowed.
   */
  onRejected?: (
    submission: Submission,
    reasonCode: string,
    reasonText: string | null,
  ) => Promise<void> | void;
  /**
   * Best-effort hook after an exception request is approved
   * (original: ringi-override DNA emission + autonomous deploy). Errors are swallowed.
   */
  onExceptionApproved?: (exception: ExceptionRequest) => Promise<void> | void;
  now?: () => Date;
  newId?: () => string;
}

export interface SubmitInput {
  tenantId: string;
  submitterId: string;
  title: string;
  contentText: string;
  creativeUrls?: string[];
  approverId?: string | null;
}

export interface DecideInput {
  action: DecisionAction;
  approverId: string;
  rejectionReasonCode?: string;
  rejectionReasonText?: string;
}

export type WorkflowErrorCode =
  | "not_found"
  | "reason_required"
  | "forbidden"
  | "invalid_status"
  | "before_not_found";

export type WorkflowResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: WorkflowErrorCode; error: string };

export interface ReapplyFix {
  before: string;
  after: string;
  rationale: string;
}

export interface SubmitExceptionInput {
  tenantId: string;
  submitterId: string;
  originalSubmissionId?: string | null;
  rejectedContent: string;
  rejectionReason: string;
  submitterOverrideArgument: string;
}

export interface DecideExceptionInput {
  action: "approved" | "rejected";
  deciderId: string;
  reasoning?: string | null;
}

/** Statuses from which the submitter may quick-fix & reapply (ported verbatim). */
const REAPPLYABLE_STATUSES: readonly SubmissionStatus[] = [
  "lint_running",
  "lint_failed",
  "draft",
  "submitted",
];

const DECISION_STATUS_MAP: Record<DecisionAction, SubmissionStatus> = {
  approve: "approved",
  reject: "rejected",
  deploy: "deployed",
  override: "override",
};

export class ApprovalWorkflow {
  constructor(private readonly deps: ApprovalWorkflowDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private newId(): string {
    return this.deps.newId ? this.deps.newId() : crypto.randomUUID();
  }

  private async swallow(hook: (() => Promise<void> | void) | undefined): Promise<void> {
    if (!hook) return;
    try {
      await hook();
    } catch {
      // Best-effort — must NOT roll back the human decision (original semantics).
    }
  }

  /**
   * Submit content for approval. Runs the injected risk evaluation, then
   * applies the original state machine:
   * riskScore > 0 → "lint_running", riskScore === 0 → "under_review".
   */
  async submit(input: SubmitInput): Promise<{ submission: Submission; evaluation: RiskEvaluation }> {
    const evaluation = await this.deps.evaluate({
      tenantId: input.tenantId,
      contentText: input.contentText,
    });

    const status: SubmissionStatus = evaluation.riskScore > 0 ? "lint_running" : "under_review";
    const nowIso = this.now().toISOString();

    const submission = await this.deps.submissions.insert({
      id: this.newId(),
      tenantId: input.tenantId,
      submitterId: input.submitterId,
      approverId: input.approverId ?? null,
      title: input.title,
      contentText: input.contentText,
      creativeUrls: input.creativeUrls ?? [],
      status,
      checkId: evaluation.checkId,
      submittedAt: nowIso,
      decidedAt: null,
      rejectionReasonCode: null,
      rejectionReasonText: null,
      overrideExceptionId: null,
      metadata: {},
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    await this.deps.notifyApprover?.(submission, evaluation);
    return { submission, evaluation };
  }

  /**
   * Record an approver decision on a submission (dashboard path).
   * Reject requires a reason code (original validation preserved).
   */
  async decide(
    submissionId: string,
    tenantId: string,
    input: DecideInput,
  ): Promise<WorkflowResult<Submission>> {
    if (input.action === "reject" && !input.rejectionReasonCode) {
      return {
        ok: false,
        code: "reason_required",
        error: "Rejection reason code required for rejection",
      };
    }

    const status = DECISION_STATUS_MAP[input.action];
    const nowIso = this.now().toISOString();

    const updated = await this.deps.submissions.update(submissionId, tenantId, {
      status,
      rejectionReasonCode: input.rejectionReasonCode ?? null,
      rejectionReasonText: input.rejectionReasonText ?? null,
      decidedAt: nowIso,
      approverId: input.approverId,
      updatedAt: nowIso,
    });
    if (!updated) return { ok: false, code: "not_found", error: "Submission not found" };

    await this.deps.audit?.({
      tenantId,
      decisionType: input.action === "reject" ? "rejection" : "approval",
      subject: `Decision (${input.action}): ${submissionId}`,
      context: "Decision recorded via approval workflow",
      reason: input.rejectionReasonText ?? null,
      source: "manual",
      decidedBy: input.approverId,
      resourceType: "submission",
      resourceId: submissionId,
      metadata: { submission_id: submissionId, action: input.action },
    });

    if (status === "approved") {
      await this.swallow(() => this.deps.onApproved?.(updated));
    } else if (status === "rejected") {
      await this.swallow(() =>
        this.deps.onRejected?.(
          updated,
          input.rejectionReasonCode ?? "",
          input.rejectionReasonText ?? null,
        ),
      );
    }

    return { ok: true, value: updated };
  }

  /**
   * Approve via Slack interaction (ported from slack-actions recordApprove).
   */
  async recordApprove(ctx: {
    submissionId: string;
    approverId: string;
    tenantId: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const nowIso = this.now().toISOString();
    const updated = await this.deps.submissions.update(ctx.submissionId, ctx.tenantId, {
      status: "approved",
      decidedAt: nowIso,
      approverId: ctx.approverId,
      updatedAt: nowIso,
    });
    if (!updated) return { ok: false, error: "Submission not found" };

    await this.deps.audit?.({
      tenantId: ctx.tenantId,
      decisionType: "approval",
      subject: `Slack approve: ${ctx.submissionId}`,
      context: "Approved via approval-workflow Slack interaction",
      reason: null,
      source: "slack",
      decidedBy: ctx.approverId,
      resourceType: "submission",
      resourceId: ctx.submissionId,
      metadata: { submission_id: ctx.submissionId },
    });

    // Original: deploy-gate hand-off. Errors are not surfaced to Slack —
    // the approval itself already succeeded.
    await this.swallow(() => this.deps.onApproved?.(updated));
    return { ok: true };
  }

  /**
   * Reject via Slack interaction with a triage reason
   * (ported from slack-actions recordReject).
   */
  async recordReject(
    ctx: { submissionId: string; approverId: string; tenantId: string },
    reasonCode: string,
    reasonText: string | null,
  ): Promise<{ ok: boolean; error?: string }> {
    const nowIso = this.now().toISOString();
    const updated = await this.deps.submissions.update(ctx.submissionId, ctx.tenantId, {
      status: "rejected",
      decidedAt: nowIso,
      approverId: ctx.approverId,
      rejectionReasonCode: reasonCode,
      rejectionReasonText: reasonText,
      updatedAt: nowIso,
    });
    if (!updated) return { ok: false, error: "Submission not found" };

    await this.deps.audit?.({
      tenantId: ctx.tenantId,
      decisionType: "rejection",
      subject: `Slack reject: ${ctx.submissionId}`,
      context: "Rejected via approval-workflow Slack interaction (Dynamic Triage)",
      reason: reasonText,
      source: "slack",
      decidedBy: ctx.approverId,
      resourceType: "submission",
      resourceId: ctx.submissionId,
      metadata: {
        submission_id: ctx.submissionId,
        reason_code: reasonCode,
        reason_text: reasonText,
      },
    });

    // Original: hard-negatives pipeline feed. Best-effort — must not break
    // the user-facing reject flow.
    await this.swallow(() => this.deps.onRejected?.(updated, reasonCode, reasonText));
    return { ok: true };
  }

  /**
   * Quick-fix reapply: replace `fix.before` with `fix.after` in the content,
   * re-run the evaluation, and move the status accordingly
   * (ported from routes/firewall/reapply.ts, guards preserved verbatim).
   */
  async reapply(
    submissionId: string,
    tenantId: string,
    userId: string,
    fix: ReapplyFix,
    violationType?: string,
  ): Promise<WorkflowResult<{ submission: Submission; evaluation: RiskEvaluation }>> {
    const submission = await this.deps.submissions.getById(submissionId, tenantId);
    if (!submission) return { ok: false, code: "not_found", error: "Submission not found" };
    if (submission.submitterId !== userId) {
      return { ok: false, code: "forbidden", error: "Only submitter can reapply" };
    }
    if (!REAPPLYABLE_STATUSES.includes(submission.status)) {
      return {
        ok: false,
        code: "invalid_status",
        error: `Cannot reapply on status=${submission.status}`,
      };
    }
    if (!submission.contentText.includes(fix.before)) {
      return {
        ok: false,
        code: "before_not_found",
        error: "Fix.before not found in current content",
      };
    }

    const newContent = submission.contentText.replace(fix.before, fix.after);
    const evaluation = await this.deps.evaluate({ tenantId, contentText: newContent });
    const newStatus: SubmissionStatus = evaluation.riskScore > 0 ? "lint_running" : "under_review";

    const updated = await this.deps.submissions.update(submissionId, tenantId, {
      contentText: newContent,
      status: newStatus,
      checkId: evaluation.checkId,
      updatedAt: this.now().toISOString(),
    });
    if (!updated) return { ok: false, code: "not_found", error: "Submission not found" };

    await this.deps.audit?.({
      tenantId,
      decisionType: "change",
      subject: `Quick Fix reapplied: ${violationType ?? "unspecified"}`,
      context: `Submission ${submissionId} content updated and re-evaluated.`,
      reason: fix.rationale,
      source: "ai_suggestion",
      decidedBy: userId,
      resourceType: "submission",
      resourceId: submissionId,
      metadata: {
        submission_id: submissionId,
        violation_type: violationType ?? null,
        before: fix.before,
        after: fix.after,
        new_risk_score: evaluation.riskScore,
        new_status: newStatus,
      },
    });

    return { ok: true, value: { submission: updated, evaluation } };
  }

  /**
   * File an exception request (稟議) against a rejection. Marks the original
   * submission as "override" (ported from exception.ts POST + ringi/submit.ts).
   */
  async submitException(input: SubmitExceptionInput): Promise<ExceptionRequest> {
    const nowIso = this.now().toISOString();
    const exception = await this.deps.exceptions.insert({
      id: this.newId(),
      tenantId: input.tenantId,
      originalSubmissionId: input.originalSubmissionId ?? null,
      rejectedContent: input.rejectedContent,
      rejectionReason: input.rejectionReason,
      submitterOverrideArgument: input.submitterOverrideArgument,
      decision: null,
      decisionAt: null,
      decisionReasoning: null,
      createdAt: nowIso,
    });

    if (input.originalSubmissionId) {
      // Original semantics: a failed update is logged but non-fatal.
      await this.deps.submissions.update(input.originalSubmissionId, input.tenantId, {
        status: "override",
        overrideExceptionId: exception.id,
        updatedAt: nowIso,
      });
    }

    await this.deps.audit?.({
      tenantId: input.tenantId,
      decisionType: "start",
      subject: `Exception Request Submitted: ${input.originalSubmissionId || "New"}`,
      context: `Override Argument: ${input.submitterOverrideArgument}`,
      reason: input.rejectionReason || "Exception request creation",
      source: "manual",
      decidedBy: input.submitterId,
      resourceType: "exception_request",
      resourceId: exception.id,
      metadata: { state: "submitted", original_submission_id: input.originalSubmissionId ?? null },
    });

    return exception;
  }

  /**
   * Senior-approver decision on an exception request. Cascades the outcome to
   * the original submission and fires the best-effort approval hook
   * (ported from exception.ts /:id/decision + ringi/approve.ts).
   */
  async decideException(
    exceptionId: string,
    tenantId: string,
    input: DecideExceptionInput,
  ): Promise<WorkflowResult<ExceptionRequest>> {
    const nowIso = this.now().toISOString();
    const updated = await this.deps.exceptions.update(exceptionId, tenantId, {
      decision: input.action,
      decisionAt: nowIso,
      decisionReasoning: input.reasoning ?? null,
    });
    if (!updated) return { ok: false, code: "not_found", error: "Exception request not found" };

    // Hash-chain style audit: approved → "change", rejected → "stop" (original mapping).
    await this.deps.audit?.({
      tenantId,
      decisionType: input.action === "approved" ? "change" : "stop",
      subject: `Exception Request ${input.action.toUpperCase()}`,
      context: `Exception Request ID: ${exceptionId}`,
      reason: input.reasoning || `Approver ${input.action}`,
      source: "manual",
      decidedBy: input.deciderId,
      resourceType: "exception_request",
      resourceId: exceptionId,
      metadata: { state: input.action, original_submission_id: updated.originalSubmissionId },
    });

    if (updated.originalSubmissionId) {
      await this.deps.submissions.update(updated.originalSubmissionId, tenantId, {
        status: input.action === "approved" ? "approved" : "rejected",
        updatedAt: nowIso,
      });
    }

    if (input.action === "approved") {
      // Best-effort — failure must NOT roll back the human decision.
      await this.swallow(() => this.deps.onExceptionApproved?.(updated));
    }

    return { ok: true, value: updated };
  }
}
