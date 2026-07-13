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

  // Deduplicate by approver_id so a single approver cannot satisfy an
  // AND-of-N gate (or veto an OR gate) by submitting multiple responses.
  // The latest response per approver wins (by responded_at, falling back to
  // arrival order), matching a "one approver = one current vote" model.
  const deduped = dedupeByApprover(responses);

  const approves = deduped.filter((r) => r.decision === "approve");
  const rejects = deduped.filter((r) => r.decision === "reject");

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

/**
 * Collapse multiple responses from the same approver into a single current
 * vote. The last response wins, ordered by `responded_at` when parseable and
 * otherwise by arrival order. This prevents a single approver from being
 * counted N times toward an AND/OR threshold.
 */
function dedupeByApprover(responses: ApprovalResponse[]): ApprovalResponse[] {
  const latest = new Map<string, { resp: ApprovalResponse; ts: number; idx: number }>();
  responses.forEach((resp, idx) => {
    const parsed = Date.parse(resp.responded_at);
    const ts = Number.isNaN(parsed) ? idx : parsed;
    const existing = latest.get(resp.approver_id);
    // Newer timestamp wins; on tie/unparseable, later arrival wins.
    if (!existing || ts > existing.ts || (ts === existing.ts && idx >= existing.idx)) {
      latest.set(resp.approver_id, { resp, ts, idx });
    }
  });
  return [...latest.values()].map((e) => e.resp);
}
