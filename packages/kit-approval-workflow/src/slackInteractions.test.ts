import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPROVE_ACTION_ID,
  REJECT_MODAL_CALLBACK_ID,
  REJECT_OPEN_ACTION_ID,
  buildRejectModalView,
  dispatchInteraction,
  handleSlackInteractionRequest,
  type ApproveButtonValue,
  type SlackInteractionHandlers,
  type SlackInteractionPayload,
  type ViewSubmissionPayload,
} from "./slackInteractions.js";

const FAKE_SECRET = "fake-slack-signing-secret";
const NOW = 1_750_000_000;
const CTX: ApproveButtonValue = {
  submissionId: "sub-1",
  approverId: "approver-1",
  tenantId: "tenant-1",
};

interface Recorded {
  approves: ApproveButtonValue[];
  rejects: Array<{ ctx: ApproveButtonValue; code: string; text: string | null }>;
  modals: Array<{ triggerId: string; ctx: ApproveButtonValue }>;
}

function makeHandlers(): { handlers: SlackInteractionHandlers; recorded: Recorded } {
  const recorded: Recorded = { approves: [], rejects: [], modals: [] };
  return {
    recorded,
    handlers: {
      approve: async (ctx) => {
        recorded.approves.push(ctx);
        return { ok: true };
      },
      reject: async (ctx, code, text) => {
        recorded.rejects.push({ ctx, code, text });
        return { ok: true };
      },
      openRejectModal: async (triggerId, ctx) => {
        recorded.modals.push({ triggerId, ctx });
      },
    },
  };
}

function signedRequest(payload: SlackInteractionPayload, secret = FAKE_SECRET): Request {
  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = String(NOW);
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
  return new Request("https://example.test/slack/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
}

function approvePayload(): SlackInteractionPayload {
  return {
    type: "block_actions",
    user: { id: "U1" },
    trigger_id: "trig-1",
    actions: [{ action_id: APPROVE_ACTION_ID, value: JSON.stringify(CTX) }],
  };
}

function rejectModalSubmission(values: {
  code?: string;
  freetext?: string;
  metadata?: string;
}): ViewSubmissionPayload {
  return {
    type: "view_submission",
    user: { id: "U1" },
    view: {
      callback_id: REJECT_MODAL_CALLBACK_ID,
      private_metadata: values.metadata ?? JSON.stringify(CTX),
      state: {
        values: {
          reason_block: {
            reason_choice: {
              type: "radio_buttons",
              ...(values.code
                ? { selected_option: { value: values.code, text: { text: `label:${values.code}` } } }
                : {}),
            },
          },
          freetext_block: {
            freetext: { type: "plain_text_input", value: values.freetext },
          },
        },
      },
    },
  };
}

describe("handleSlackInteractionRequest (signature + dispatch end-to-end)", () => {
  it("verifies the signature and records an approval", async () => {
    const { handlers, recorded } = makeHandlers();
    const res = await handleSlackInteractionRequest(signedRequest(approvePayload()), {
      signingSecret: FAKE_SECRET,
      handlers,
      now: () => NOW,
    });
    expect(res.status).toBe(200);
    expect(recorded.approves).toEqual([CTX]);
  });

  it("rejects a request signed with the wrong secret (401, handler untouched)", async () => {
    const { handlers, recorded } = makeHandlers();
    const res = await handleSlackInteractionRequest(
      signedRequest(approvePayload(), "wrong-secret"),
      { signingSecret: FAKE_SECRET, handlers, now: () => NOW },
    );
    expect(res.status).toBe(401);
    expect(recorded.approves).toHaveLength(0);
  });

  it("returns 503 when no signing secret is configured", async () => {
    const { handlers } = makeHandlers();
    const res = await handleSlackInteractionRequest(signedRequest(approvePayload()), {
      signingSecret: "",
      handlers,
      now: () => NOW,
    });
    expect(res.status).toBe(503);
  });

  it("returns 400 for a signed request without a payload field", async () => {
    const { handlers } = makeHandlers();
    const rawBody = "not_payload=1";
    const ts = String(NOW);
    const signature = `v0=${createHmac("sha256", FAKE_SECRET).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
    const res = await handleSlackInteractionRequest(
      new Request("https://example.test/", {
        method: "POST",
        headers: { "x-slack-request-timestamp": ts, "x-slack-signature": signature },
        body: rawBody,
      }),
      { signingSecret: FAKE_SECRET, handlers, now: () => NOW },
    );
    expect(res.status).toBe(400);
  });
});

describe("dispatchInteraction", () => {
  it("opens the reject modal with the triage options from the button value", async () => {
    const { handlers, recorded } = makeHandlers();
    const res = await dispatchInteraction(
      {
        type: "block_actions",
        user: { id: "U1" },
        trigger_id: "trig-9",
        actions: [
          {
            action_id: REJECT_OPEN_ACTION_ID,
            value: JSON.stringify({ ...CTX, options: [{ code: "tone", label: "トーン不一致" }] }),
          },
        ],
      },
      handlers,
    );
    expect(res.status).toBe(200);
    expect(recorded.modals).toEqual([{ triggerId: "trig-9", ctx: CTX }]);
  });

  it("acks (200) but does nothing on a malformed button value — never a retry storm", async () => {
    const { handlers, recorded } = makeHandlers();
    const res = await dispatchInteraction(
      {
        type: "block_actions",
        user: { id: "U1" },
        trigger_id: "t",
        actions: [{ action_id: APPROVE_ACTION_ID, value: "{not json" }],
      },
      handlers,
    );
    expect(res.status).toBe(200);
    expect(recorded.approves).toHaveLength(0);
  });

  it("records a rejection from a completed modal, using the option label as reason text", async () => {
    const { handlers, recorded } = makeHandlers();
    const res = await dispatchInteraction(rejectModalSubmission({ code: "tone" }), handlers);
    expect(await res.json()).toEqual({ response_action: "clear" });
    expect(recorded.rejects).toEqual([{ ctx: CTX, code: "tone", text: "label:tone" }]);
  });

  it("uses the freetext as reason text when その他 (other) is selected", async () => {
    const { handlers, recorded } = makeHandlers();
    await dispatchInteraction(
      rejectModalSubmission({ code: "other", freetext: "個別事情あり" }),
      handlers,
    );
    expect(recorded.rejects[0]).toMatchObject({ code: "other", text: "個別事情あり" });
  });

  it("validates: その他 without freetext returns a field error", async () => {
    const { handlers, recorded } = makeHandlers();
    const res = await dispatchInteraction(rejectModalSubmission({ code: "other" }), handlers);
    const body = (await res.json()) as { response_action: string; errors: Record<string, string> };
    expect(body.response_action).toBe("errors");
    expect(body.errors.freetext_block).toBeTruthy();
    expect(recorded.rejects).toHaveLength(0);
  });

  it("validates: missing reason selection returns a field error", async () => {
    const { handlers } = makeHandlers();
    const res = await dispatchInteraction(rejectModalSubmission({}), handlers);
    const body = (await res.json()) as { response_action: string; errors: Record<string, string> };
    expect(body.response_action).toBe("errors");
    expect(body.errors.reason_block).toBeTruthy();
  });
});

describe("buildRejectModalView", () => {
  it("caps triage options at 3 and always appends その他", () => {
    const view = buildRejectModalView(CTX, [
      { code: "a", label: "A" },
      { code: "b", label: "B" },
      { code: "c", label: "C" },
      { code: "d", label: "D" },
    ]);
    const blocks = view.blocks as Array<{
      element?: { options?: Array<{ value: string }> };
    }>;
    const optionValues = blocks[0]?.element?.options?.map((o) => o.value);
    expect(optionValues).toEqual(["a", "b", "c", "other"]);
    expect(view.callback_id).toBe(REJECT_MODAL_CALLBACK_ID);
    expect(JSON.parse(view.private_metadata as string)).toEqual(CTX);
  });
});
