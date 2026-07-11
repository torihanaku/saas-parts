/**
 * Multi-approver response aggregator.
 * Pure function to determine final status based on multiple responses and mode.
 *
 * Ported verbatim from dev-dashboard-v2 server/services/approvalAggregator.ts.
 */

export type ApprovalDecision = "approve" | "reject";

export interface ApprovalResponse {
  approver_id: string;
  decision: ApprovalDecision;
  responded_at: string;
}

export type AggregateFinalStatus = "approved" | "rejected" | "pending";

export type ApprovalMode = "single" | "and" | "or";

export interface AggregateResult {
  status: AggregateFinalStatus;
  reason?: string;
}

/**
 * Aggregates multiple approver responses based on the specified mode.
 *
 * Modes:
 * - 'single': Any one response decides the outcome (usually for 1-approver cases).
 * - 'and': All assigned approvers must approve for 'approved'. Any one reject leads to 'rejected'.
 * - 'or': Any one approve leads to 'approved'. All must reject for 'rejected'.
 *
 * @param responses List of responses received so far.
 * @param totalRequired Total number of approvers assigned to this submission.
 * @param mode Aggregation strategy.
 */
export function aggregate(
  responses: ApprovalResponse[],
  totalRequired: number,
  mode: ApprovalMode,
): AggregateResult {
  if (totalRequired <= 0) return { status: "approved" };
  if (responses.length === 0) return { status: "pending" };

  const approves = responses.filter((r) => r.decision === "approve");
  const rejects = responses.filter((r) => r.decision === "reject");

  switch (mode) {
    case "single":
      // First response wins
      if (approves.length > 0) return { status: "approved" };
      if (rejects.length > 0) return { status: "rejected" };
      return { status: "pending" };

    case "and":
      // Must have all approvals to be 'approved'
      if (rejects.length > 0) {
        return {
          status: "rejected",
          reason: `Rejected by ${rejects[0]!.approver_id}`,
        };
      }
      if (approves.length >= totalRequired) {
        return { status: "approved" };
      }
      return { status: "pending" };

    case "or":
      // Any one approval is enough
      if (approves.length > 0) {
        return { status: "approved" };
      }
      // Must have all rejects to be 'rejected'
      if (rejects.length >= totalRequired) {
        return {
          status: "rejected",
          reason: "Rejected by all approvers",
        };
      }
      return { status: "pending" };

    default:
      return { status: "pending" };
  }
}
