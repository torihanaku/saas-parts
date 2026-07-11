import { describe, expect, it } from "vitest";
import { runEscalationJob, type EscalationPolicy } from "./escalation.js";
import { InMemorySubmissionStore } from "./stores.js";
import type { AuditEntry, Submission, SubmissionStatus } from "./types.js";

const NOW = new Date("2026-07-11T12:00:00Z");
const TENANT = "tenant-1";

function makeSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: overrides.id ?? "sub-1",
    tenantId: TENANT,
    submitterId: "user-1",
    approverId: "approver-1",
    title: "t",
    contentText: "c",
    creativeUrls: [],
    status: "under_review",
    checkId: null,
    submittedAt: "2026-07-10T00:00:00Z", // 36h before NOW → past the 24h timeout
    decidedAt: null,
    rejectionReasonCode: null,
    rejectionReasonText: null,
    overrideExceptionId: null,
    metadata: {},
    createdAt: "2026-07-10T00:00:00Z",
    updatedAt: "2026-07-10T00:00:00Z",
    ...overrides,
  };
}

const enabledPolicy: EscalationPolicy = {
  enabled: true,
  timeout_hours: 24,
  next_approver_id: "senior-approver",
};

describe("runEscalationJob", () => {
  it("escalates a pending submission past the timeout: reassigns, flags, audits, notifies", async () => {
    const submissions = new InMemorySubmissionStore();
    await submissions.insert(makeSubmission());
    const audits: AuditEntry[] = [];
    const notified: Submission[] = [];

    const result = await runEscalationJob({
      submissions,
      getPolicy: async () => enabledPolicy,
      audit: (e) => void audits.push(e),
      notify: async (s) => void notified.push(s),
      now: () => NOW,
    });

    expect(result.escalated).toBe(1);
    const updated = await submissions.getById("sub-1", TENANT);
    expect(updated?.approverId).toBe("senior-approver");
    expect(updated?.metadata.escalated).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      decisionType: "change",
      source: "system",
      resourceId: "sub-1",
      metadata: {
        method: "auto_escalation",
        previous_approver: "approver-1",
        next_approver: "senior-approver",
      },
    });
    // The NEW approver is notified
    expect(notified[0]?.approverId).toBe("senior-approver");
  });

  it("does not escalate submissions inside the timeout window", async () => {
    const submissions = new InMemorySubmissionStore();
    await submissions.insert(
      makeSubmission({ submittedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() }),
    );
    const result = await runEscalationJob({
      submissions,
      getPolicy: async () => enabledPolicy,
      now: () => NOW,
    });
    expect(result.escalated).toBe(0);
  });

  it("does not escalate already-decided submissions (status transition guard)", async () => {
    const submissions = new InMemorySubmissionStore();
    await submissions.insert(makeSubmission({ status: "approved" }));
    await submissions.insert(makeSubmission({ id: "sub-2", status: "rejected" }));
    const result = await runEscalationJob({
      submissions,
      getPolicy: async () => enabledPolicy,
      now: () => NOW,
    });
    expect(result.escalated).toBe(0);
  });

  it("skips when the policy is disabled or missing", async () => {
    const submissions = new InMemorySubmissionStore();
    await submissions.insert(makeSubmission());
    expect(
      (
        await runEscalationJob({
          submissions,
          getPolicy: async () => ({ ...enabledPolicy, enabled: false }),
          now: () => NOW,
        })
      ).escalated,
    ).toBe(0);
    expect(
      (
        await runEscalationJob({
          submissions,
          getPolicy: async () => null,
          now: () => NOW,
        })
      ).escalated,
    ).toBe(0);
    const untouched = await submissions.getById("sub-1", TENANT);
    expect(untouched?.approverId).toBe("approver-1");
  });

  it("escalates only once: the second run skips via metadata.escalated", async () => {
    const submissions = new InMemorySubmissionStore();
    await submissions.insert(makeSubmission());
    const deps = {
      submissions,
      getPolicy: async () => enabledPolicy,
      now: () => NOW,
    };
    expect((await runEscalationJob(deps)).escalated).toBe(1);
    expect((await runEscalationJob(deps)).escalated).toBe(0);
  });

  it("continues with the remaining submissions when one policy lookup throws", async () => {
    const submissions = new InMemorySubmissionStore();
    await submissions.insert(makeSubmission({ id: "sub-bad", tenantId: "bad-tenant" }));
    await submissions.insert(makeSubmission({ id: "sub-good" }));
    const result = await runEscalationJob({
      submissions,
      getPolicy: async (tenantId) => {
        if (tenantId === "bad-tenant") throw new Error("policy backend down");
        return enabledPolicy;
      },
      now: () => NOW,
    });
    expect(result.escalated).toBe(1);
  });

  it("honours custom pending statuses and timeout", async () => {
    const submissions = new InMemorySubmissionStore();
    await submissions.insert(
      makeSubmission({
        status: "draft" as SubmissionStatus,
        submittedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString(),
      }),
    );
    const result = await runEscalationJob({
      submissions,
      getPolicy: async () => enabledPolicy,
      now: () => NOW,
      pendingStatuses: ["draft"],
      timeoutHours: 2,
    });
    expect(result.escalated).toBe(1);
  });
});
