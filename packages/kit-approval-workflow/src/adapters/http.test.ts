import { describe, expect, it } from "vitest";
import { createApprovalHttpAdapter, type AuthedUser } from "./http.js";
import { ApprovalWorkflow } from "../workflow.js";
import { InMemoryExceptionRequestStore, InMemorySubmissionStore } from "../stores.js";
import type { Submission } from "../types.js";

const submitter: AuthedUser = { id: "user-1", tenantId: "tenant-1" };
const approver: AuthedUser = { id: "approver-1", tenantId: "tenant-1" };

function makeAdapter() {
  const submissions = new InMemorySubmissionStore();
  const workflow = new ApprovalWorkflow({
    submissions,
    exceptions: new InMemoryExceptionRequestStore(),
    evaluate: async ({ contentText }) => ({
      checkId: "check-1",
      riskScore: contentText.includes("NG") ? 5 : 0,
      violations: [],
    }),
  });
  return { adapter: createApprovalHttpAdapter({ workflow }), submissions };
}

function post(body: unknown): Request {
  return new Request("https://example.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("createApprovalHttpAdapter (submit → approve lifecycle over HTTP)", () => {
  it("submits then approves a clean submission", async () => {
    const { adapter } = makeAdapter();

    const submitRes = await adapter.submit(
      post({ title: "Campaign", contentText: "clean copy" }),
      submitter,
    );
    expect(submitRes.status).toBe(200);
    const submitted = (await submitRes.json()) as { data: Submission };
    expect(submitted.data.status).toBe("under_review");

    const decideRes = await adapter.decide(post({ action: "approve" }), approver, submitted.data.id);
    expect(decideRes.status).toBe(200);
    const decided = (await decideRes.json()) as { data: Submission };
    expect(decided.data.status).toBe("approved");
    expect(decided.data.approverId).toBe("approver-1");
  });

  it("returns 400 when required submit fields are missing", async () => {
    const { adapter } = makeAdapter();
    const res = await adapter.submit(post({ title: "no content" }), submitter);
    expect(res.status).toBe(400);
  });

  it("maps workflow error codes to HTTP statuses (reject without reason → 400, missing → 404)", async () => {
    const { adapter } = makeAdapter();
    const submitRes = await adapter.submit(post({ title: "t", contentText: "c" }), submitter);
    const { data } = (await submitRes.json()) as { data: Submission };

    const noReason = await adapter.decide(post({ action: "reject" }), approver, data.id);
    expect(noReason.status).toBe(400);

    const missing = await adapter.decide(post({ action: "approve" }), approver, "nonexistent");
    expect(missing.status).toBe(404);
  });

  it("runs the reapply flow and enforces the submitter guard (403)", async () => {
    const { adapter } = makeAdapter();
    const submitRes = await adapter.submit(post({ title: "t", contentText: "has NG word" }), submitter);
    const { data } = (await submitRes.json()) as { data: Submission };
    expect(data.status).toBe("lint_running");

    const forbidden = await adapter.reapply(
      post({ fix: { before: "NG", after: "ok", rationale: "" } }),
      approver, // not the submitter
      data.id,
    );
    expect(forbidden.status).toBe(403);

    const fixed = await adapter.reapply(
      post({ fix: { before: "NG word", after: "fine copy", rationale: "cleanup" } }),
      submitter,
      data.id,
    );
    expect(fixed.status).toBe(200);
    const reapplied = (await fixed.json()) as { data: Submission };
    expect(reapplied.data.status).toBe("under_review");
  });

  it("files and decides an exception request (稟議), cascading to the submission", async () => {
    const { adapter, submissions } = makeAdapter();
    const submitRes = await adapter.submit(post({ title: "t", contentText: "c" }), submitter);
    const { data } = (await submitRes.json()) as { data: Submission };
    await adapter.decide(
      post({ action: "reject", rejectionReasonCode: "tone" }),
      approver,
      data.id,
    );

    const exceptionRes = await adapter.submitException(
      post({
        originalSubmissionId: data.id,
        rejectedContent: "c",
        rejectionReason: "tone",
        submitterOverrideArgument: "実績あり",
      }),
      submitter,
    );
    expect(exceptionRes.status).toBe(201);
    const { data: exception } = (await exceptionRes.json()) as { data: { id: string } };

    const decisionRes = await adapter.decideException(
      post({ action: "approve", reasoning: "許容範囲" }),
      approver,
      exception.id,
    );
    expect(decisionRes.status).toBe(200);
    const stored = await submissions.getById(data.id, "tenant-1");
    expect(stored?.status).toBe("approved");
  });

  it("returns 503 from the Slack endpoint when Slack is not configured", async () => {
    const { adapter } = makeAdapter();
    const res = await adapter.slackInteractions(post({}));
    expect(res.status).toBe(503);
  });
});
