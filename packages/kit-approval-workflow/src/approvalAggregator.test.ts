import { describe, expect, it } from "vitest";
import { aggregate, type ApprovalResponse } from "./approvalAggregator.js";

const approve = (id: string): ApprovalResponse => ({
  approver_id: id,
  decision: "approve",
  responded_at: "2026-01-01T00:00:00Z",
});
const reject = (id: string): ApprovalResponse => ({
  approver_id: id,
  decision: "reject",
  responded_at: "2026-01-01T00:00:00Z",
});

describe("aggregate", () => {
  it("returns approved when no approvers are required", () => {
    expect(aggregate([], 0, "and").status).toBe("approved");
    expect(aggregate([], -1, "or").status).toBe("approved");
  });

  it("returns pending when there are no responses yet", () => {
    expect(aggregate([], 2, "and").status).toBe("pending");
    expect(aggregate([], 2, "or").status).toBe("pending");
    expect(aggregate([], 1, "single").status).toBe("pending");
  });

  describe("single mode", () => {
    it("first approve wins", () => {
      expect(aggregate([approve("a")], 1, "single").status).toBe("approved");
    });
    it("first reject wins", () => {
      expect(aggregate([reject("a")], 1, "single").status).toBe("rejected");
    });
  });

  describe("and mode (unanimous approval)", () => {
    it("stays pending until all have approved", () => {
      expect(aggregate([approve("a")], 2, "and").status).toBe("pending");
    });
    it("approves once all required approvals arrive", () => {
      expect(aggregate([approve("a"), approve("b")], 2, "and").status).toBe("approved");
    });
    it("a single reject vetoes immediately, with the rejector in the reason", () => {
      const result = aggregate([approve("a"), reject("b")], 3, "and");
      expect(result.status).toBe("rejected");
      expect(result.reason).toBe("Rejected by b");
    });
  });

  describe("or mode (any approval)", () => {
    it("a single approve is enough", () => {
      expect(aggregate([reject("a"), approve("b")], 3, "or").status).toBe("approved");
    });
    it("stays pending while rejects are not unanimous", () => {
      expect(aggregate([reject("a")], 2, "or").status).toBe("pending");
    });
    it("rejects only when all approvers rejected", () => {
      const result = aggregate([reject("a"), reject("b")], 2, "or");
      expect(result.status).toBe("rejected");
      expect(result.reason).toBe("Rejected by all approvers");
    });
  });
});
