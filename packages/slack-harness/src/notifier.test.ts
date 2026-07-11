/**
 * Tests for notifier.ts — Block Kit 構築（移植元 buildBlockKitPayload /
 * buildRejectModalView 相当）と Slack API 呼び出しの検証。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildApprovalBlockKit,
  buildRejectModalView,
  resolveSlackUserIdByEmail,
  postSlackDm,
  notifyByEmail,
  type ApprovalSubmission,
  type RiskAssessment,
} from "./notifier";

const SUBMISSION: ApprovalSubmission = {
  id: "sub-1",
  tenantId: "tenant-1",
  submitterId: "user-2",
  approverId: "user-1",
  title: "Test",
  contentText: "Content",
};

const RISK: RiskAssessment = { riskScore: 10, summary: "OK" };

const silentDeps = { logWarn: () => {}, logError: () => {} };

describe("buildApprovalBlockKit", () => {
  it("builds header, risk, divider, main proposal and actions blocks", () => {
    const payload = buildApprovalBlockKit(SUBMISSION, RISK, []);
    expect(payload.text).toBe("【要承認】Test");
    const types = payload.blocks.map((b) => b.type);
    expect(types).toEqual(["section", "section", "divider", "section", "actions"]);

    const header = payload.blocks[0] as { text: { text: string } };
    expect(header.text.text).toContain("<@user-2>");
    expect(header.text.text).toContain("*Test*");

    const riskBlock = payload.blocks[1] as { text: { text: string } };
    expect(riskBlock.text.text).toContain("⚠️ Risk Score: 10");
    expect(riskBlock.text.text).toContain("OK");
  });

  it("uses severity emoji thresholds (>40 red, >0 warning, 0 ok)", () => {
    const red = buildApprovalBlockKit(SUBMISSION, { riskScore: 50, summary: "" }, []);
    expect(JSON.stringify(red.blocks[1])).toContain("🔴");
    const ok = buildApprovalBlockKit(SUBMISSION, { riskScore: 0, summary: "" }, []);
    expect(JSON.stringify(ok.blocks[1])).toContain("✅");
  });

  it("truncates long content to 200 chars with ellipsis", () => {
    const long = { ...SUBMISSION, contentText: "x".repeat(250) };
    const payload = buildApprovalBlockKit(long, RISK, []);
    const main = payload.blocks[3] as { text: { text: string } };
    expect(main.text.text).toContain("x".repeat(200) + "…");
    expect(main.text.text).not.toContain("x".repeat(201));
  });

  it("renders alternatives as 案B, 案C sections", () => {
    const payload = buildApprovalBlockKit(SUBMISSION, RISK, [], [
      { deviationAxis: "トーン", estimatedRisk: "低", content: "alt-1", hypothesizedUpside: "CTR向上" },
      { deviationAxis: "構成", estimatedRisk: "中", content: "alt-2", hypothesizedUpside: "認知拡大" },
    ]);
    const texts = payload.blocks.map((b) => JSON.stringify(b));
    expect(texts.some((t) => t.includes("チャレンジャー案"))).toBe(true);
    expect(texts.some((t) => t.includes("*案B*") && t.includes("トーン"))).toBe(true);
    expect(texts.some((t) => t.includes("*案C*") && t.includes("構成"))).toBe(true);
  });

  it("includes reject options in context block and reject button value", () => {
    const options = [{ code: "tone_error", label: "トーン不一致" }];
    const payload = buildApprovalBlockKit(SUBMISSION, RISK, options);
    const context = payload.blocks.find((b) => b.type === "context");
    expect(JSON.stringify(context)).toContain("トーン不一致");

    const actions = payload.blocks.find((b) => b.type === "actions") as {
      block_id: string;
      elements: Array<{ action_id: string; value: string }>;
    };
    expect(actions.block_id).toBe("approval_actions_sub-1");
    const reject = actions.elements.find((e) => e.action_id === "approval_reject_open")!;
    expect(JSON.parse(reject.value)).toMatchObject({
      submissionId: "sub-1",
      approverId: "user-1",
      tenantId: "tenant-1",
      options,
    });
    const approve = actions.elements.find((e) => e.action_id === "approval_approve")!;
    expect(JSON.parse(approve.value)).toEqual({
      submissionId: "sub-1",
      approverId: "user-1",
      tenantId: "tenant-1",
    });
  });

  it("supports copy overrides for product-specific wording", () => {
    const payload = buildApprovalBlockKit(SUBMISSION, RISK, [], undefined, {
      headline: "新企画案の提出がありました",
      notificationTextPrefix: "【要承認】新企画案: ",
      actionsBlockIdPrefix: "firewall_actions_",
      approveActionId: "firewall_approve",
      rejectActionId: "firewall_reject_open",
    });
    expect(payload.text).toBe("【要承認】新企画案: Test");
    expect(JSON.stringify(payload.blocks[0])).toContain("新企画案の提出がありました");
    const actions = payload.blocks.find((b) => b.type === "actions") as { block_id: string };
    expect(actions.block_id).toBe("firewall_actions_sub-1");
  });
});

describe("buildRejectModalView", () => {
  const context = { submissionId: "sub-1", approverId: "user-1", tenantId: "tenant-1" };

  it("builds modal with radio options (max 3) + fallback and freetext input", () => {
    const view = buildRejectModalView(context, [
      { code: "a", label: "A" },
      { code: "b", label: "B" },
      { code: "c", label: "C" },
      { code: "d", label: "D" }, // 4th is trimmed
    ]) as {
      type: string;
      callback_id: string;
      private_metadata: string;
      blocks: Array<{ element: { type: string; options?: Array<{ value: string }> } }>;
    };

    expect(view.type).toBe("modal");
    expect(view.callback_id).toBe("approval_reject_modal");
    expect(JSON.parse(view.private_metadata)).toEqual(context);

    const radio = view.blocks[0]!.element;
    expect(radio.type).toBe("radio_buttons");
    expect(radio.options!.map((o) => o.value)).toEqual(["a", "b", "c", "other"]);

    const freetext = view.blocks[1]!.element as { type: string; max_length: number };
    expect(freetext.type).toBe("plain_text_input");
    expect(freetext.max_length).toBe(500);
  });

  it("supports copy overrides (callback_id etc.)", () => {
    const view = buildRejectModalView(context, [], { callbackId: "firewall_reject_modal" }) as { callback_id: string };
    expect(view.callback_id).toBe("firewall_reject_modal");
  });
});

describe("Slack API helpers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
  });

  it("resolveSlackUserIdByEmail returns id on success", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, user: { id: "U123" } }), { status: 200 }));
    const id = await resolveSlackUserIdByEmail("approver@example.com", "xoxb-token", { fetchImpl: fetchMock as unknown as typeof fetch, ...silentDeps });
    expect(id).toBe("U123");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("users.lookupByEmail?email=approver%40example.com");
  });

  it("resolveSlackUserIdByEmail returns null on lookup failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "users_not_found" }), { status: 200 }));
    const id = await resolveSlackUserIdByEmail("ghost@example.com", "xoxb-token", { fetchImpl: fetchMock as unknown as typeof fetch, ...silentDeps });
    expect(id).toBeNull();
  });

  it("postSlackDm posts payload to chat.postMessage", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const payload = buildApprovalBlockKit(SUBMISSION, RISK, []);
    const sent = await postSlackDm("U123", payload, "xoxb-token", { fetchImpl: fetchMock as unknown as typeof fetch, ...silentDeps });
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("blocks"),
      }),
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.channel).toBe("U123");
  });

  it("postSlackDm returns false when Slack responds ok=false", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }));
    const sent = await postSlackDm("U404", { text: "t", blocks: [] }, "xoxb-token", { fetchImpl: fetchMock as unknown as typeof fetch, ...silentDeps });
    expect(sent).toBe(false);
  });

  it("notifyByEmail resolves the user then sends DM (ported from notifyApprover flow)", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, user: { id: "U123" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const payload = buildApprovalBlockKit(SUBMISSION, RISK, [{ code: "tone_error", label: "トーン不一致" }]);
    const sent = await notifyByEmail("approver@example.com", payload, "xoxb-token", { fetchImpl: fetchMock as unknown as typeof fetch, ...silentDeps });
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("blocks"),
      }),
    );
  });

  it("notifyByEmail skips DM when the user cannot be resolved", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "users_not_found" }), { status: 200 }));
    const sent = await notifyByEmail("ghost@example.com", { text: "t", blocks: [] }, "xoxb-token", { fetchImpl: fetchMock as unknown as typeof fetch, ...silentDeps });
    expect(sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
