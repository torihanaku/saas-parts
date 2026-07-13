/**
 * Approval escalation: per-tenant policy resolution + timeout escalation job.
 *
 * Ported from 実運用SaaS:
 *   - server/services/escalationPolicy.ts (EscalationPolicy shape)
 *   - server/jobs/approval-escalation.ts  (runEscalationJob state machine)
 *
 * Differences from the original (see README):
 *   - Policy lookup is an injected resolver instead of Supabase tenants/teams.
 *   - After escalating we SET metadata.escalated = true. The original checked
 *     the flag but never set it, so a submission could be re-escalated on
 *     every run — a latent bug fixed here.
 *   - The pending-status list and timeout are configurable (defaults preserved).
 */
import type { AuditLogger, Submission, SubmissionStatus } from "./types.js";
import type { SubmissionStore } from "./stores.js";

export interface EscalationPolicy {
  enabled: boolean;
  timeout_hours: number;
  /** Next-level approver to reassign to. */
  next_approver_id: string;
}

/** Resolves the escalation policy for a tenant (original: tenants → teams fallback). */
export type EscalationPolicyResolver = (tenantId: string) => Promise<EscalationPolicy | null>;

/** Notify the newly assigned approver (original: Slack DM via notifyApprover). */
export type EscalationNotifier = (submission: Submission) => Promise<void>;

/** Original job scanned these statuses. */
export const DEFAULT_PENDING_STATUSES: readonly SubmissionStatus[] = [
  "submitted",
  "lint_running",
  "under_review",
];

export const DEFAULT_ESCALATION_TIMEOUT_HOURS = 24;

export interface EscalationJobDeps {
  submissions: SubmissionStore;
  getPolicy: EscalationPolicyResolver;
  notify?: EscalationNotifier;
  audit?: AuditLogger;
  now?: () => Date;
  pendingStatuses?: readonly SubmissionStatus[];
  /** Fallback timeout when the policy does not specify one. Default 24h. */
  timeoutHours?: number;
  log?: (message: string) => void;
}

/**
 * Scans for pending submissions that have not been decided within the timeout
 * (default 24h) and escalates them to the next-level approver.
 */
export async function runEscalationJob(deps: EscalationJobDeps): Promise<{ escalated: number }> {
  const now = deps.now ? deps.now() : new Date();
  const log = deps.log ?? (() => undefined);
  const timeoutHours = deps.timeoutHours ?? DEFAULT_ESCALATION_TIMEOUT_HOURS;
  const pendingStatuses = deps.pendingStatuses ?? DEFAULT_PENDING_STATUSES;
  let escalatedCount = 0;

  log("[EscalationJob] Starting scan for pending submissions...");

  const cutoffIso = new Date(now.getTime() - timeoutHours * 60 * 60 * 1000).toISOString();
  const pendingSubmissions = await deps.submissions.listPendingOlderThan(
    pendingStatuses,
    cutoffIso,
  );

  if (pendingSubmissions.length === 0) {
    log("[EscalationJob] No pending submissions found for escalation.");
    return { escalated: 0 };
  }

  for (const submission of pendingSubmissions) {
    try {
      const policy = await deps.getPolicy(submission.tenantId);
      if (!policy || !policy.enabled || !policy.next_approver_id) {
        continue;
      }

      // Skip if already escalated.
      if (submission.metadata?.escalated) {
        continue;
      }

      const updated = await deps.submissions.update(submission.id, submission.tenantId, {
        approverId: policy.next_approver_id,
        metadata: { ...submission.metadata, escalated: true },
        updatedAt: now.toISOString(),
      });
      if (!updated) {
        log(`[EscalationJob] Failed to escalate submission ${submission.id}`);
        continue;
      }

      await deps.audit?.({
        tenantId: submission.tenantId,
        decisionType: "change", // escalation is a change of approver
        subject: `Auto-escalation: ${submission.id}`,
        context: `Submission pending for > ${timeoutHours}h (submitted at ${submission.submittedAt})`,
        reason: `Automatic escalation policy triggered. Original approver: ${submission.approverId}`,
        source: "system",
        decidedBy: null,
        resourceType: "submission",
        resourceId: submission.id,
        metadata: {
          method: "auto_escalation",
          previous_approver: submission.approverId,
          next_approver: policy.next_approver_id,
        },
      });

      // Notify the NEW approver.
      await deps.notify?.(updated);

      log(
        `[EscalationJob] Successfully escalated submission ${submission.id} to ${policy.next_approver_id}`,
      );
      escalatedCount++;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log(`[EscalationJob] Error processing submission ${submission.id}: ${error.message}`);
    }
  }

  return { escalated: escalatedCount };
}
