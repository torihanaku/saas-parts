/**
 * Ported from dev-dashboard-v2 tests/server/services/email-parser.test.ts
 * (JA + EN fixtures) + config-injection cases added for the package.
 */
import { describe, it, expect } from "vitest";
import { parseReply } from "./index";

describe("email-decision-parser (EN fixtures)", () => {
  it("should parse 'approve' from the first line", () => {
    const body = "Approve\n\nOn Wed, Apr 22, 2026 at 5:00 PM wrote:";
    const result = parseReply(body);
    expect(result).toEqual({ decision: "approve" });
  });

  it("should parse 'approved' from the first line", () => {
    const body = "Approved. Looks good to me.";
    const result = parseReply(body);
    expect(result).toEqual({ decision: "approve" });
  });

  it("should parse 'ok' / 'yes' shorthands", () => {
    expect(parseReply("OK, go ahead")).toEqual({ decision: "approve" });
    expect(parseReply("Yes")).toEqual({ decision: "approve" });
  });

  it("should parse 'reject' with reason", () => {
    const body = "Reject: This is too expensive.\n\nPlease revise.";
    const result = parseReply(body);
    expect(result).toEqual({
      decision: "reject",
      reason: "This is too expensive. Please revise.",
    });
  });

  it("should parse 'rejected' with reason on subsequent lines", () => {
    const body = "Rejected\nThe budget exceeds our quarterly limit.\n> On Wed, Apr 22, 2026...";
    const result = parseReply(body);
    expect(result).toEqual({
      decision: "reject",
      reason: "The budget exceeds our quarterly limit.",
    });
  });

  it("should parse 'deny' as rejection without reason", () => {
    const result = parseReply("Deny");
    expect(result).toEqual({ decision: "reject", reason: undefined });
  });
});

describe("email-decision-parser (JA fixtures)", () => {
  it("should parse Japanese '承認'", () => {
    const body = "承認します。";
    const result = parseReply(body);
    expect(result).toEqual({ decision: "approve" });
  });

  it("should parse Japanese '却下' with reason", () => {
    const body = "却下\n内容が不十分です。";
    const result = parseReply(body);
    expect(result).toEqual({
      decision: "reject",
      reason: "内容が不十分です。",
    });
  });

  it("should parse Japanese '不承認'", () => {
    const result = parseReply("不承認");
    expect(result).toEqual({ decision: "reject", reason: undefined });
  });

  it("should parse Japanese '却下: 理由' inline reason", () => {
    const result = parseReply("却下: 予算超過のため");
    expect(result).toEqual({ decision: "reject", reason: "予算超過のため" });
  });
});

describe("email-decision-parser (edge cases)", () => {
  it("should return null for unclear responses", () => {
    const body = "I will think about it.";
    const result = parseReply(body);
    expect(result).toBeNull();
  });

  it("should return null for empty body", () => {
    expect(parseReply("")).toBeNull();
    expect(parseReply("\n\n  \n")).toBeNull();
  });
});

describe("email-decision-parser (config injection)", () => {
  it("supports custom approval/rejection keyword sets", () => {
    const config = {
      approvalPatterns: [/^\s*lgtm/i],
      rejectionPatterns: [/^\s*nack/i],
    };
    expect(parseReply("LGTM!", config)).toEqual({ decision: "approve" });
    expect(parseReply("NACK", config)).toEqual({ decision: "reject", reason: undefined });
    // Default keywords are inactive when overridden
    expect(parseReply("Approve", config)).toBeNull();
  });

  it("supports custom inline reason pattern", () => {
    const config = {
      rejectionPatterns: [/^\s*nack/i],
      inlineReasonPattern: /^nack[\s:]+(.*)$/i,
    };
    expect(parseReply("NACK: needs more tests", config)).toEqual({
      decision: "reject",
      reason: "needs more tests",
    });
  });
});
