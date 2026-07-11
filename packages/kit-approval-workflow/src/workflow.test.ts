import { describe, expect, it } from "vitest";
import {
  ApprovalWorkflow,
  type ApprovalWorkflowDeps,
  type RiskEvaluator,
} from "./workflow.js";
import { InMemoryExceptionRequestStore, InMemorySubmissionStore } from "./stores.js";
import type { AuditEntry, RiskEvaluation, Submission } from "./types.js";

const TENANT = "tenant-1";

function cleanEvaluator(): RiskEvaluator {
  return async () => ({ checkId: "check-1", riskScore: 0, violations: [] });
}

function flaggedEvaluator(score = 3): RiskEvaluator {
  return async () => ({
    checkId: "check-flagged",
    riskScore: score,
    violations: [{ rule: "r1" }],
  });
}

interface Harness {
  workflow: ApprovalWorkflow;
  submissions: InMemorySubmissionStore;
  exceptions: InMemoryExceptionRequestStore;
  audits: AuditEntry[];
  notified: Array<{ submission: Submission; evaluation: RiskEvaluation }>;
}

function makeHarness(overrides: Partial<ApprovalWorkflowDeps> = {}): Harness {
  const submissions = new InMemorySubmissionStore();
  const exceptions = new InMemoryExceptionRequestStore();
  const audits: AuditEntry[] = [];
  const notified: Array<{ submission: Submission; evaluation: RiskEvaluation }> = [];
  let seq = 0;
  const workflow = new ApprovalWorkflow({
    submissions,
    exceptions,
    evaluate: cleanEvaluator(),
    notifyApprover: async (submission, evaluation) => {
      notified.push({ submission, evaluation });
    },
    audit: (entry) => {
      audits.push(entry);
    },
    now: () => new Date("2026-07-11T00:00:00Z"),
    newId: () => `id-${++seq}`,
    ...overrides,
  });
  return { workflow, submissions, exceptions, audits, notified };
}

describe("ApprovalWorkflow.submit", () => {
  it("moves a clean submission to under_review and notifies the approver", async () => {
    const h = makeHarness();
    const { submission, evaluation } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "New campaign",
      contentText: "Hello world",
      approverId: "approver-1",
    });
    expect(submission.status).toBe("under_review");
    expect(submission.checkId).toBe("check-1");
    expect(submission.submittedAt).toBe("2026-07-11T00:00:00.000Z");
    expect(evaluation.riskScore).toBe(0);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]!.submission.id).toBe(submission.id);
  });

  it("moves a flagged submission (riskScore > 0) to lint_running", async () => {
    const h = makeHarness({ evaluate: flaggedEvaluator() });
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "Risky",
      contentText: "NG word here",
    });
    expect(submission.status).toBe("lint_running");
    expect(submission.checkId).toBe("check-flagged");
  });
});

describe("ApprovalWorkflow.decide", () => {
  it("submit → approve lifecycle records the decision, audit, and approved hook", async () => {
    const approvedHook: Submission[] = [];
    const h = makeHarness({ onApproved: (s) => void approvedHook.push(s) });
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "c",
    });

    const result = await h.workflow.decide(submission.id, TENANT, {
      action: "approve",
      approverId: "approver-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.status).toBe("approved");
    expect(result.value.approverId).toBe("approver-1");
    expect(result.value.decidedAt).toBe("2026-07-11T00:00:00.000Z");

    expect(approvedHook).toHaveLength(1);
    const audit = h.audits.find((a) => a.decisionType === "approval");
    expect(audit?.resourceId).toBe(submission.id);
    expect(audit?.source).toBe("manual");
  });

  it("requires a reason code for rejection", async () => {
    const h = makeHarness();
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "c",
    });
    const result = await h.workflow.decide(submission.id, TENANT, {
      action: "reject",
      approverId: "approver-1",
    });
    expect(result).toMatchObject({ ok: false, code: "reason_required" });
  });

  it("records rejection with reason and fires the rejected hook", async () => {
    const rejectedHook: Array<{ code: string; text: string | null }> = [];
    const h = makeHarness({
      onRejected: (_s, code, text) => void rejectedHook.push({ code, text }),
    });
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "c",
    });
    const result = await h.workflow.decide(submission.id, TENANT, {
      action: "reject",
      approverId: "approver-1",
      rejectionReasonCode: "tone",
      rejectionReasonText: "トーンが合わない",
    });
    expect(result.ok).toBe(true);
    expect(rejectedHook).toEqual([{ code: "tone", text: "トーンが合わない" }]);
    expect(h.audits.some((a) => a.decisionType === "rejection")).toBe(true);
  });

  it("is tenant-scoped: deciding with the wrong tenant returns not_found", async () => {
    const h = makeHarness();
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "c",
    });
    const result = await h.workflow.decide(submission.id, "other-tenant", {
      action: "approve",
      approverId: "approver-1",
    });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });

  it("swallows hook failures — the human decision must stand", async () => {
    const h = makeHarness({
      onApproved: () => {
        throw new Error("deploy gate exploded");
      },
    });
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "c",
    });
    const result = await h.workflow.decide(submission.id, TENANT, {
      action: "approve",
      approverId: "approver-1",
    });
    expect(result.ok).toBe(true);
    const stored = await h.submissions.getById(submission.id, TENANT);
    expect(stored?.status).toBe("approved");
  });
});

describe("ApprovalWorkflow Slack record paths", () => {
  it("recordApprove approves and audits with source=slack", async () => {
    const h = makeHarness();
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "c",
    });
    const result = await h.workflow.recordApprove({
      submissionId: submission.id,
      approverId: "approver-1",
      tenantId: TENANT,
    });
    expect(result.ok).toBe(true);
    const stored = await h.submissions.getById(submission.id, TENANT);
    expect(stored?.status).toBe("approved");
    expect(h.audits.at(-1)?.source).toBe("slack");
  });

  it("recordReject persists the triage reason", async () => {
    const h = makeHarness();
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "c",
    });
    const result = await h.workflow.recordReject(
      { submissionId: submission.id, approverId: "approver-1", tenantId: TENANT },
      "legal",
      "法務リスク",
    );
    expect(result.ok).toBe(true);
    const stored = await h.submissions.getById(submission.id, TENANT);
    expect(stored?.status).toBe("rejected");
    expect(stored?.rejectionReasonCode).toBe("legal");
    expect(stored?.rejectionReasonText).toBe("法務リスク");
  });
});

describe("ApprovalWorkflow.reapply", () => {
  it("replaces the offending text, re-evaluates, and moves to under_review when clean", async () => {
    let call = 0;
    const h = makeHarness({
      evaluate: async ({ contentText }) => {
        call++;
        return contentText.includes("NG")
          ? { checkId: `check-${call}`, riskScore: 5, violations: ["ng-word"] }
          : { checkId: `check-${call}`, riskScore: 0, violations: [] };
      },
    });
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "This has an NG word",
    });
    expect(submission.status).toBe("lint_running");

    const result = await h.workflow.reapply(submission.id, TENANT, "user-1", {
      before: "NG word",
      after: "fine phrase",
      rationale: "remove flagged term",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.submission.status).toBe("under_review");
    expect(result.value.submission.contentText).toBe("This has an fine phrase");
    expect(h.audits.some((a) => a.decisionType === "change" && a.source === "ai_suggestion")).toBe(true);
  });

  it("only the submitter may reapply", async () => {
    const h = makeHarness({ evaluate: flaggedEvaluator() });
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "NG",
    });
    const result = await h.workflow.reapply(submission.id, TENANT, "intruder", {
      before: "NG",
      after: "ok",
      rationale: "",
    });
    expect(result).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("cannot reapply on a decided submission", async () => {
    const h = makeHarness();
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "c",
    });
    await h.workflow.decide(submission.id, TENANT, { action: "approve", approverId: "a" });
    const result = await h.workflow.reapply(submission.id, TENANT, "user-1", {
      before: "c",
      after: "d",
      rationale: "",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_status" });
  });

  it("rejects when fix.before is not present in the content", async () => {
    const h = makeHarness({ evaluate: flaggedEvaluator() });
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "NG",
    });
    const result = await h.workflow.reapply(submission.id, TENANT, "user-1", {
      before: "missing",
      after: "x",
      rationale: "",
    });
    expect(result).toMatchObject({ ok: false, code: "before_not_found" });
  });
});

describe("ApprovalWorkflow exception (稟議) flow", () => {
  it("submitException marks the original submission as override", async () => {
    const h = makeHarness();
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "c",
    });
    await h.workflow.decide(submission.id, TENANT, {
      action: "reject",
      approverId: "a",
      rejectionReasonCode: "tone",
    });

    const exception = await h.workflow.submitException({
      tenantId: TENANT,
      submitterId: "user-1",
      originalSubmissionId: submission.id,
      rejectedContent: "c",
      rejectionReason: "tone",
      submitterOverrideArgument: "過去に同種表現で成果が出ている",
    });
    expect(exception.decision).toBeNull();

    const stored = await h.submissions.getById(submission.id, TENANT);
    expect(stored?.status).toBe("override");
    expect(stored?.overrideExceptionId).toBe(exception.id);
  });

  it("approving an exception cascades approval to the original submission and fires the hook", async () => {
    const hookCalls: string[] = [];
    const h = makeHarness({ onExceptionApproved: (e) => void hookCalls.push(e.id) });
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "c",
    });
    const exception = await h.workflow.submitException({
      tenantId: TENANT,
      submitterId: "user-1",
      originalSubmissionId: submission.id,
      rejectedContent: "c",
      rejectionReason: "tone",
      submitterOverrideArgument: "arg",
    });

    const result = await h.workflow.decideException(exception.id, TENANT, {
      action: "approved",
      deciderId: "senior-1",
      reasoning: "ビジネス判断で許容",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.decision).toBe("approved");
    expect(result.value.decisionReasoning).toBe("ビジネス判断で許容");

    const stored = await h.submissions.getById(submission.id, TENANT);
    expect(stored?.status).toBe("approved");
    expect(hookCalls).toEqual([exception.id]);
    // approved exception → audit decisionType "change" (original mapping)
    expect(h.audits.at(-1)?.decisionType).toBe("change");
  });

  it("rejecting an exception cascades rejection and audits as stop", async () => {
    const h = makeHarness();
    const { submission } = await h.workflow.submit({
      tenantId: TENANT,
      submitterId: "user-1",
      title: "t",
      contentText: "c",
    });
    const exception = await h.workflow.submitException({
      tenantId: TENANT,
      submitterId: "user-1",
      originalSubmissionId: submission.id,
      rejectedContent: "c",
      rejectionReason: "tone",
      submitterOverrideArgument: "arg",
    });

    const result = await h.workflow.decideException(exception.id, TENANT, {
      action: "rejected",
      deciderId: "senior-1",
    });
    expect(result.ok).toBe(true);
    const stored = await h.submissions.getById(submission.id, TENANT);
    expect(stored?.status).toBe("rejected");
    expect(h.audits.at(-1)?.decisionType).toBe("stop");
  });

  it("deciding a missing exception returns not_found", async () => {
    const h = makeHarness();
    const result = await h.workflow.decideException("nope", TENANT, {
      action: "approved",
      deciderId: "senior-1",
    });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });
});
