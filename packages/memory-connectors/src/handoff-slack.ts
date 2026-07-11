/**
 * Slack DM delivery for the memory handoff (ported from dev-dashboard-v2
 * institutional-memory/handoff-slack, MEM-7 / #1233).
 *
 * All calls go through an injected proxy (`SlackProxy`) — no direct Slack SDK
 * dependency. Failures degrade gracefully (returns ok=false with a `note`) and
 * never throw.
 */

import type { MemoryLogger } from "./types.js";
import { NOOP_LOGGER } from "./types.js";

/** Slack chat.postMessage caps text at ~40k. Stay well under. */
const SLACK_MAX_TEXT_LEN = 35_000;

export interface SlackDeliveryResult {
  ok: boolean;
  /** Human-readable reason when ok=false. */
  note?: string;
}

/**
 * Injected Slack HTTP proxy. Mirrors the original Nango proxy surface: a single
 * `request` that returns `{ data }` where `data` is the parsed Slack API body.
 */
export interface SlackProxy {
  request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ data?: T } | null>;
}

export interface HandoffSlackDeps {
  proxy: SlackProxy;
  logger?: MemoryLogger;
}

/**
 * Best-effort Slack DM via the injected proxy.
 *
 * `recipient` may be a Slack user id (`U...`) — used directly — or an email,
 * resolved via users.lookupByEmail then conversations.open. Returns ok=false
 * with a `note` on any failure. Never throws.
 */
export async function deliverViaSlack(
  recipient: string,
  markdown: string,
  deps: HandoffSlackDeps,
): Promise<SlackDeliveryResult> {
  const logger = deps.logger ?? NOOP_LOGGER;
  if (!recipient || !recipient.trim()) {
    return { ok: false, note: "missing_recipient" };
  }

  const text =
    markdown.length > SLACK_MAX_TEXT_LEN
      ? `${markdown.slice(0, SLACK_MAX_TEXT_LEN)}\n\n_(truncated — see full export)_`
      : markdown;

  try {
    const channelId = await resolveSlackChannel(recipient.trim(), deps.proxy);
    if (!channelId) {
      logger.warn(
        "institutional-memory.handoff.slack",
        `Could not resolve Slack channel for recipient=${recipient}`,
      );
      return { ok: false, note: "slack_recipient_unresolved" };
    }

    const res = await deps.proxy.request<{ ok?: boolean; error?: string }>(
      "POST",
      "/chat.postMessage",
      { channel: channelId, text, mrkdwn: true },
    );
    if (!res || !res.data?.ok) {
      const err = res?.data?.error ?? "unknown_error";
      logger.warn(
        "institutional-memory.handoff.slack",
        `chat.postMessage failed: ${err}`,
      );
      return { ok: false, note: `slack_post_failed:${err}` };
    }
    logger.info(
      "institutional-memory.handoff.slack",
      `delivered handoff to ${recipient} via ${channelId}`,
    );
    return { ok: true };
  } catch (err) {
    logger.error("institutional-memory.handoff.slack", err);
    return { ok: false, note: "slack_exception" };
  }
}

async function resolveSlackChannel(
  recipient: string,
  proxy: SlackProxy,
): Promise<string | null> {
  // Direct user id (e.g. U01ABCDEF) — Slack accepts user ids as a channel.
  if (/^U[A-Z0-9]{6,}$/i.test(recipient)) return recipient;

  // Email → lookupByEmail → user id → conversations.open → channel id
  if (recipient.includes("@")) {
    const lookup = await proxy.request<{
      ok?: boolean;
      user?: { id?: string };
      error?: string;
    }>("GET", `/users.lookupByEmail?email=${encodeURIComponent(recipient)}`);
    const userId = lookup?.data?.user?.id;
    if (!userId) return null;

    const open = await proxy.request<{
      ok?: boolean;
      channel?: { id?: string };
      error?: string;
    }>("POST", "/conversations.open", { users: userId });
    return open?.data?.channel?.id ?? null;
  }
  // Display names without a users.list lookup — out of scope.
  return null;
}
