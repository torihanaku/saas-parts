/**
 * Email Reply Parser for headless approval.
 * Extracts decisions (approve/reject) and reasons from email MIME bodies.
 *
 * Ported from 実運用SaaS server/services/emailReplyParser.ts.
 * Keyword sets are configurable; defaults are the source JA/EN patterns.
 */

export interface EmailDecision {
  decision: "approve" | "reject";
  reason?: string;
}

export interface EmailDecisionParserConfig {
  /** Patterns matched against the (lowercased) first line to detect approval. */
  approvalPatterns?: RegExp[];
  /** Patterns matched against the (lowercased) first line to detect rejection. */
  rejectionPatterns?: RegExp[];
  /**
   * Pattern to extract an inline reason from the first line
   * (e.g. "Reject: too expensive"). Capture group 1 is the reason.
   */
  inlineReasonPattern?: RegExp;
  /**
   * Filter for subsequent lines when collecting a rejection reason.
   * Return false to drop the line (default drops quoted lines and
   * "On ... wrote:" reply markers).
   */
  replyMarkerFilter?: (line: string) => boolean;
}

/**
 * Source defaults (EN + JA).
 *
 * SECURITY: each Latin keyword is anchored with a word boundary (`\b`) so it only
 * matches as a whole decision token, not as the prefix of an unrelated word. Without
 * this, `/^\s*yes/i` matched "yesterday…" and `/^\s*ok/i` matched "okey dokey I decline",
 * causing a non-approval reply to be parsed as an approval in a headless approval flow.
 * ("ok" additionally accepts the "okay" spelling.)
 */
export const DEFAULT_APPROVAL_PATTERNS: readonly RegExp[] = [
  /^\s*approve\b/i,
  /^\s*approved\b/i,
  /^\s*ok(?:ay)?\b/i,
  /^\s*yes\b/i,
  /^\s*承認/,
];

/** Source defaults (EN + JA). Latin keywords are word-boundary anchored (see approval note). */
export const DEFAULT_REJECTION_PATTERNS: readonly RegExp[] = [
  /^\s*reject\b/i,
  /^\s*rejected\b/i,
  /^\s*no\b/i,
  /^\s*deny\b/i,
  /^\s*却下/,
  /^\s*不承認/,
];

/** Source default: reason after the rejection keyword on the same line. */
export const DEFAULT_INLINE_REASON_PATTERN = /^(?:reject|rejected|却下|不承認)[\s:]+(.*)$/i;

function defaultReplyMarkerFilter(line: string): boolean {
  return !line.startsWith(">") && !line.toLowerCase().includes("wrote:");
}

/**
 * Parses the MIME body of an email reply to extract a decision.
 *
 * Logic:
 * 1. Convert to lowercase for matching.
 * 2. Look for keywords like "approve", "approved", "ok", "yes" for approval.
 * 3. Look for keywords like "reject", "rejected", "no", "deny" for rejection.
 * 4. Extract any text following the decision as the reason,
 *    or look for specific "Reason: ..." patterns.
 */
export function parseReply(
  mimeBody: string,
  config: EmailDecisionParserConfig = {},
): EmailDecision | null {
  if (!mimeBody) return null;

  const approvalKeywords = config.approvalPatterns ?? DEFAULT_APPROVAL_PATTERNS;
  const rejectionKeywords = config.rejectionPatterns ?? DEFAULT_REJECTION_PATTERNS;
  const inlineReasonPattern = config.inlineReasonPattern ?? DEFAULT_INLINE_REASON_PATTERN;
  const replyMarkerFilter = config.replyMarkerFilter ?? defaultReplyMarkerFilter;

  // Simple implementation: focus on the first few lines of the reply
  const lines = mimeBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = lines[0];
  if (!firstLine) return null;

  const firstLineLower = firstLine.toLowerCase();

  // 1. Check for Approval
  const isApproved = approvalKeywords.some((regex) => regex.test(firstLineLower));
  if (isApproved) {
    return { decision: "approve" };
  }

  // 2. Check for Rejection
  const isRejected = rejectionKeywords.some((regex) => regex.test(firstLineLower));
  if (isRejected) {
    // If rejected, try to find a reason in the subsequent lines
    let reason = "";
    if (lines.length > 1) {
      // Filter out common reply markers like "On ... wrote:"
      const subsequentLines = lines.slice(1).filter(replyMarkerFilter);
      reason = subsequentLines.join(" ").trim();
    }

    // Also check if the first line has a reason after the keyword, e.g., "Reject: too expensive"
    // Use the original case for the reason
    const rejectMatch = firstLine.match(inlineReasonPattern);
    if (rejectMatch && rejectMatch[1]) {
      reason = rejectMatch[1].trim() + (reason ? " " + reason : "");
    }

    return {
      decision: "reject",
      reason: reason || undefined,
    };
  }

  return null;
}
