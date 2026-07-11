/**
 * Slack Block Kit interaction handling for the approval workflow.
 *
 * Ported from dev-dashboard-v2:
 *   - server/routes/firewall/slack-dispatch.ts      (payload types + dispatch)
 *   - server/routes/firewall/slack-interactions.ts  (HTTP entrypoint)
 *   - server/lib/firewall/slack-notifier.ts         (buildRejectModalView)
 *   - server/routes/firewall/slack-actions.ts       (openRejectModal HTTP call)
 *
 * Decoupling: decisions are executed via injected handlers (typically a
 * bound {@link ApprovalWorkflow}); the Slack views.open call goes through an
 * injected {@link SlackViewOpener} built with an explicit token — no env vars.
 *
 * Flow (original semantics preserved):
 *   - block_actions / approve action        → mark submission approved
 *   - block_actions / reject-open action    → open reject reason modal
 *   - view_submission / reject modal submit → mark submission rejected
 *
 * Slack expects a 200 within 3s, so handlers ack quickly and malformed
 * payloads are answered with 200 + a logged error (never a retry storm).
 */
import { verifySlackSignature } from "./slackSignature.js";
import type { TriageOption } from "./types.js";

/* ────────────────────────────────────────────────────────────────────────── */
/* Payload types (ported verbatim)                                            */
/* ────────────────────────────────────────────────────────────────────────── */

interface SlackUser {
  id: string;
  username?: string;
}

export interface BlockActionsPayload {
  type: "block_actions";
  user: SlackUser;
  trigger_id: string;
  team?: { id: string };
  actions: Array<{ action_id: string; value?: string }>;
}

export interface ViewSubmissionPayload {
  type: "view_submission";
  user: SlackUser;
  view: {
    callback_id: string;
    private_metadata?: string;
    state: {
      values: Record<
        string,
        Record<
          string,
          {
            type: string;
            selected_option?: { value: string; text?: { text: string } };
            value?: string;
          }
        >
      >;
    };
  };
}

export type SlackInteractionPayload = BlockActionsPayload | ViewSubmissionPayload;

/** Context carried in each button's `value` / modal `private_metadata`. */
export interface ApproveButtonValue {
  submissionId: string;
  approverId: string;
  tenantId: string;
}

export interface RejectOpenButtonValue extends ApproveButtonValue {
  options: TriageOption[];
}

export type RejectModalContext = ApproveButtonValue;

export type ActionResult = { ok: boolean; error?: string };

/* ────────────────────────────────────────────────────────────────────────── */
/* Reject modal Block Kit view (ported verbatim)                              */
/* ────────────────────────────────────────────────────────────────────────── */

export const REJECT_MODAL_CALLBACK_ID = "firewall_reject_modal";
export const APPROVE_ACTION_ID = "firewall_approve";
export const REJECT_OPEN_ACTION_ID = "firewall_reject_open";

export function buildRejectModalView(
  context: RejectModalContext,
  triageOptions: TriageOption[],
): Record<string, unknown> {
  const fallback: TriageOption = { code: "other", label: "その他（自由記述）" };
  const allOptions = [...triageOptions.slice(0, 3), fallback];

  return {
    type: "modal",
    callback_id: REJECT_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(context),
    title: { type: "plain_text", text: "却下理由を選択" },
    submit: { type: "plain_text", text: "却下を確定" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "reason_block",
        label: { type: "plain_text", text: "却下の主な理由" },
        element: {
          type: "radio_buttons",
          action_id: "reason_choice",
          options: allOptions.map((o) => ({
            text: { type: "plain_text", text: o.label },
            value: o.code,
          })),
        },
      },
      {
        type: "input",
        block_id: "freetext_block",
        optional: true,
        label: { type: "plain_text", text: "補足 (任意 / 「その他」選択時は必須)" },
        element: {
          type: "plain_text_input",
          action_id: "freetext",
          multiline: true,
          max_length: 500,
        },
      },
    ],
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Injected Slack sender                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/** Opens a Slack modal (views.open). Injected so tests / other transports can stub it. */
export type SlackViewOpener = (
  triggerId: string,
  view: Record<string, unknown>,
) => Promise<void>;

/**
 * Default HTTP implementation of {@link SlackViewOpener}
 * (ported from slack-actions openRejectModal — token injected, not env).
 */
export function createHttpSlackViewOpener(options: {
  token: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): SlackViewOpener {
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => undefined);
  return async (triggerId, view) => {
    if (!options.token) {
      log("[ApprovalSlack] Slack bot token missing — modal cannot be opened");
      return;
    }
    const res = await doFetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify({ trigger_id: triggerId, view }),
    });
    if (!res.ok) {
      log(`[ApprovalSlack] views.open HTTP ${res.status}`);
      return;
    }
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok) log(`[ApprovalSlack] views.open error: ${body.error}`);
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Dispatch (ported from slack-dispatch.ts; storage swapped for handlers)     */
/* ────────────────────────────────────────────────────────────────────────── */

export interface SlackInteractionHandlers {
  /** Record an approval (typically ApprovalWorkflow.recordApprove). */
  approve(ctx: ApproveButtonValue): Promise<ActionResult>;
  /** Record a rejection with the triage reason (typically ApprovalWorkflow.recordReject). */
  reject(
    ctx: RejectModalContext,
    reasonCode: string,
    reasonText: string | null,
  ): Promise<ActionResult>;
  /** Open the reject-reason modal. */
  openRejectModal(
    triggerId: string,
    ctx: RejectModalContext,
    options: TriageOption[],
  ): Promise<void>;
  log?: (message: string) => void;
}

function tryParse<T>(s: string | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

async function handleApprove(
  handlers: SlackInteractionHandlers,
  value: string | undefined,
): Promise<Response> {
  const log = handlers.log ?? (() => undefined);
  const ctx = tryParse<ApproveButtonValue>(value);
  if (!ctx?.submissionId || !ctx.approverId || !ctx.tenantId) {
    log("[ApprovalSlack] approve: missing fields in button value");
    return new Response("", { status: 200 });
  }
  const result = await handlers.approve(ctx);
  if (!result.ok) log(`[ApprovalSlack] approve failed: ${result.error}`);
  return new Response("", { status: 200 });
}

async function handleRejectOpen(
  handlers: SlackInteractionHandlers,
  triggerId: string,
  value: string | undefined,
): Promise<Response> {
  const log = handlers.log ?? (() => undefined);
  const parsed = tryParse<RejectOpenButtonValue>(value);
  if (!parsed?.submissionId || !parsed.approverId || !parsed.tenantId) {
    log("[ApprovalSlack] reject_open: missing fields in button value");
    return new Response("", { status: 200 });
  }
  await handlers.openRejectModal(
    triggerId,
    {
      submissionId: parsed.submissionId,
      approverId: parsed.approverId,
      tenantId: parsed.tenantId,
    },
    parsed.options ?? [],
  );
  return new Response("", { status: 200 });
}

async function handleViewSubmission(
  handlers: SlackInteractionHandlers,
  payload: ViewSubmissionPayload,
): Promise<Response> {
  if (payload.view.callback_id !== REJECT_MODAL_CALLBACK_ID) {
    return Response.json({ response_action: "clear" });
  }
  const ctx = tryParse<RejectModalContext>(payload.view.private_metadata);
  if (!ctx?.submissionId || !ctx.approverId || !ctx.tenantId) {
    return Response.json({
      response_action: "errors",
      errors: { reason_block: "Submission context missing" },
    });
  }

  const reasonChoice = payload.view.state.values.reason_block?.reason_choice;
  const freetext = payload.view.state.values.freetext_block?.freetext?.value ?? null;
  const code = reasonChoice?.selected_option?.value ?? null;
  if (!code) {
    return Response.json({
      response_action: "errors",
      errors: { reason_block: "却下理由を選択してください" },
    });
  }
  if (code === "other" && (!freetext || freetext.trim().length === 0)) {
    return Response.json({
      response_action: "errors",
      errors: { freetext_block: "「その他」選択時は補足が必須です" },
    });
  }
  const reasonText =
    code === "other" ? freetext : (reasonChoice?.selected_option?.text?.text ?? null);

  const result = await handlers.reject(ctx, code, reasonText);
  if (!result.ok) {
    return Response.json({
      response_action: "errors",
      errors: { reason_block: result.error ?? "却下処理に失敗しました" },
    });
  }
  return Response.json({ response_action: "clear" });
}

export async function dispatchInteraction(
  payload: SlackInteractionPayload,
  handlers: SlackInteractionHandlers,
): Promise<Response> {
  if (payload.type === "block_actions") {
    const action = payload.actions[0];
    if (!action) return new Response("", { status: 200 });
    if (action.action_id === APPROVE_ACTION_ID) return handleApprove(handlers, action.value);
    if (action.action_id === REJECT_OPEN_ACTION_ID) {
      return handleRejectOpen(handlers, payload.trigger_id, action.value);
    }
    return new Response("", { status: 200 });
  }

  if (payload.type === "view_submission") {
    return handleViewSubmission(handlers, payload);
  }

  return new Response("", { status: 200 });
}

/* ────────────────────────────────────────────────────────────────────────── */
/* HTTP entrypoint (ported from slack-interactions.ts; framework-free)        */
/* ────────────────────────────────────────────────────────────────────────── */

export interface SlackInteractionRequestOptions {
  signingSecret: string;
  handlers: SlackInteractionHandlers;
  /** Epoch seconds; overridable for deterministic tests. */
  now?: () => number;
}

/**
 * Handle a Slack interaction HTTP request (`application/x-www-form-urlencoded`
 * with `payload=<json>`): verify the signature, parse, and dispatch.
 */
export async function handleSlackInteractionRequest(
  req: Request,
  options: SlackInteractionRequestOptions,
): Promise<Response> {
  if (!options.signingSecret) {
    return new Response("Slack signing secret not configured", { status: 503 });
  }

  const rawBody = await req.text();
  const ok = verifySlackSignature(
    options.signingSecret,
    rawBody,
    req.headers.get("x-slack-request-timestamp"),
    req.headers.get("x-slack-signature"),
    options.now ? options.now() : undefined,
  );
  if (!ok) return new Response("Invalid signature", { status: 401 });

  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) return new Response("Missing payload", { status: 400 });

  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(payloadStr) as SlackInteractionPayload;
  } catch {
    return new Response("Invalid payload JSON", { status: 400 });
  }

  return dispatchInteraction(payload, options.handlers);
}
