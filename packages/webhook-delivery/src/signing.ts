import { createHmac } from "node:crypto";

/**
 * Signs a webhook payload using HMAC-SHA256.
 * Returns the hex-encoded signature.
 *
 * Ported from 実運用SaaS/server/lib/webhook-signing.ts
 * (only the part actually used by webhook-delivery.ts).
 */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
