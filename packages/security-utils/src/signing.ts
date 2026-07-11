import { createHmac } from "node:crypto";

/**
 * Signs a webhook payload using HMAC-SHA256.
 * Returns the hex-encoded signature.
 */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verifies a webhook signature using timing-safe comparison.
 * signature: the signature from header (hex string)
 * secret: the shared secret
 */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = signPayload(payload, secret);
  if (expected.length !== signature.length) return false;

  // Timing-safe comparison to prevent timing attacks
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}
