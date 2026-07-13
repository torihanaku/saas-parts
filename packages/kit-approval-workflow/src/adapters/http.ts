/**
 * Thin, framework-free HTTP route adapters over {@link ApprovalWorkflow}.
 *
 * Mirrors the original Hono routes (実運用SaaS server/routes/firewall/*
 * and server/routes/ringi/*) but with:
 *   - Web-standard Request/Response instead of a framework context, so the
 *     handlers can be mounted on Hono, Express (via adapters), Bun.serve,
 *     Cloud Run functions, etc.
 *   - Authentication delegated to the caller: pass the authenticated user
 *     (id + tenantId) explicitly. The original resolved this from a Supabase
 *     JWT (`user.app_metadata.tenant_id`) — a deliberate injection point.
 *   - Validation done with hand-rolled guards instead of zod, to keep the kit
 *     dependency-free (swap in your own schema validation in production).
 *
 * These are EXAMPLES of how to wire the core into HTTP; the core itself never
 * touches Request/Response.
 */
import type { ApprovalWorkflow, WorkflowErrorCode } from "../workflow.js";
import {
  handleSlackInteractionRequest,
  buildRejectModalView,
  type SlackViewOpener,
} from "../slackInteractions.js";
import type { TriageOption } from "../types.js";

/** Authenticated caller — resolve from your session/JWT middleware. */
export interface AuthedUser {
  id: string;
  tenantId: string;
}

export interface ApprovalHttpAdapterOptions {
  workflow: ApprovalWorkflow;
  /** Required only for the Slack interactions endpoint. */
  slack?: {
    signingSecret: string;
    openView: SlackViewOpener;
    /** Triage options shown in the reject modal (top 3 + その他). */
    triageOptions?: TriageOption[];
  };
  log?: (message: string) => void;
}

export interface ApprovalHttpAdapter {
  /** POST /submissions — original: POST /api/firewall/submit */
  submit(req: Request, user: AuthedUser): Promise<Response>;
  /** POST /submissions/:id/decision — original: POST /api/firewall/submissions/:id/decision */
  decide(req: Request, user: AuthedUser, submissionId: string): Promise<Response>;
  /** POST /submissions/:id/reapply — original: POST /api/firewall/submissions/:id/reapply */
  reapply(req: Request, user: AuthedUser, submissionId: string): Promise<Response>;
  /** POST /exceptions — original: POST /api/firewall/exceptions (稟議申請) */
  submitException(req: Request, user: AuthedUser): Promise<Response>;
  /** POST /exceptions/:id/decision — original: POST /api/firewall/exceptions/:id/decision */
  decideException(req: Request, user: AuthedUser, exceptionId: string): Promise<Response>;
  /** POST /slack/interactions — original: POST /api/firewall/slack/interactions */
  slackInteractions(req: Request): Promise<Response>;
}

const ERROR_STATUS: Record<WorkflowErrorCode, number> = {
  not_found: 404,
  reason_required: 400,
  forbidden: 403,
  invalid_status: 409,
  before_not_found: 422,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function createApprovalHttpAdapter(
  options: ApprovalHttpAdapterOptions,
): ApprovalHttpAdapter {
  const { workflow } = options;
  const log = options.log ?? (() => undefined);

  return {
    async submit(req, user) {
      const body = await readJson(req);
      if (!body || !isNonEmptyString(body.title) || !isNonEmptyString(body.contentText)) {
        return json({ error: "title and contentText are required" }, 400);
      }
      try {
        const { submission, evaluation } = await workflow.submit({
          tenantId: user.tenantId,
          submitterId: user.id,
          title: body.title,
          contentText: body.contentText,
          creativeUrls: Array.isArray(body.creativeUrls)
            ? body.creativeUrls.filter(isNonEmptyString)
            : [],
          approverId: isNonEmptyString(body.approverId) ? body.approverId : null,
        });
        return json({ success: true, data: submission, evaluation });
      } catch (error) {
        log(`[ApprovalHttp] submission failed: ${String(error)}`);
        return json({ error: "Submission failed" }, 500);
      }
    },

    async decide(req, user, submissionId) {
      const body = await readJson(req);
      const action = body?.action;
      if (action !== "approve" && action !== "reject" && action !== "override" && action !== "deploy") {
        return json({ error: "Invalid action" }, 400);
      }
      const result = await workflow.decide(submissionId, user.tenantId, {
        action,
        approverId: user.id,
        rejectionReasonCode: isNonEmptyString(body?.rejectionReasonCode)
          ? body.rejectionReasonCode
          : undefined,
        rejectionReasonText: isNonEmptyString(body?.rejectionReasonText)
          ? body.rejectionReasonText
          : undefined,
      });
      if (!result.ok) return json({ error: result.error }, ERROR_STATUS[result.code]);
      return json({ success: true, data: result.value });
    },

    async reapply(req, user, submissionId) {
      const body = await readJson(req);
      const fix = body?.fix as Record<string, unknown> | undefined;
      if (
        !fix ||
        !isNonEmptyString(fix.before) ||
        typeof fix.after !== "string" ||
        typeof fix.rationale !== "string"
      ) {
        return json({ error: "fix.before / fix.after / fix.rationale are required" }, 400);
      }
      const result = await workflow.reapply(
        submissionId,
        user.tenantId,
        user.id,
        { before: fix.before, after: fix.after, rationale: fix.rationale },
        isNonEmptyString(body?.violationType) ? body.violationType : undefined,
      );
      if (!result.ok) return json({ error: result.error }, ERROR_STATUS[result.code]);
      return json({
        success: true,
        data: result.value.submission,
        evaluation: result.value.evaluation,
      });
    },

    async submitException(req, user) {
      const body = await readJson(req);
      if (
        !body ||
        !isNonEmptyString(body.rejectedContent) ||
        !isNonEmptyString(body.submitterOverrideArgument)
      ) {
        return json(
          { error: "rejectedContent and submitterOverrideArgument are required" },
          400,
        );
      }
      const exception = await workflow.submitException({
        tenantId: user.tenantId,
        submitterId: user.id,
        originalSubmissionId: isNonEmptyString(body.originalSubmissionId)
          ? body.originalSubmissionId
          : null,
        rejectedContent: body.rejectedContent,
        rejectionReason: isNonEmptyString(body.rejectionReason) ? body.rejectionReason : "",
        submitterOverrideArgument: body.submitterOverrideArgument,
      });
      return json({ success: true, data: exception }, 201);
    },

    async decideException(req, user, exceptionId) {
      const body = await readJson(req);
      const action = body?.action;
      if (action !== "approve" && action !== "reject") {
        return json({ error: "Invalid action" }, 400);
      }
      const result = await workflow.decideException(exceptionId, user.tenantId, {
        action: action === "approve" ? "approved" : "rejected",
        deciderId: user.id,
        reasoning: isNonEmptyString(body?.reasoning) ? body.reasoning : null,
      });
      if (!result.ok) return json({ error: result.error }, ERROR_STATUS[result.code]);
      return json({ success: true, data: result.value });
    },

    async slackInteractions(req) {
      const slack = options.slack;
      if (!slack) return new Response("Slack not configured", { status: 503 });
      return handleSlackInteractionRequest(req, {
        signingSecret: slack.signingSecret,
        handlers: {
          approve: (ctx) => workflow.recordApprove(ctx),
          reject: (ctx, code, text) => workflow.recordReject(ctx, code, text),
          openRejectModal: async (triggerId, ctx, opts) => {
            const triage = opts.length > 0 ? opts : (slack.triageOptions ?? []);
            await slack.openView(triggerId, buildRejectModalView(ctx, triage));
          },
          log,
        },
      });
    },
  };
}
