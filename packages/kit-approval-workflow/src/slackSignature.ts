/**
 * Slack request-signature verification.
 *
 * Ported verbatim from 実運用SaaS server/routes/firewall/slack-signature.ts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SLACK_SIG_VERSION = "v0";
const SLACK_TIMESTAMP_TOLERANCE_S = 60 * 5;

/**
 * Verify a Slack request signature per https://api.slack.com/authentication/verifying-requests-from-slack.
 * `now` defaults to the current epoch in seconds — overridable for deterministic tests.
 */
export function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  now: number = Date.now() / 1000,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (Number.isNaN(ts)) return false;
  if (Math.abs(now - ts) > SLACK_TIMESTAMP_TOLERANCE_S) return false;

  const baseString = `${SLACK_SIG_VERSION}:${timestamp}:${rawBody}`;
  const computed = `${SLACK_SIG_VERSION}=${createHmac("sha256", signingSecret).update(baseString).digest("hex")}`;

  if (computed.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}
