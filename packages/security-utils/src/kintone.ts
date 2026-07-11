import { verifySignature } from "./signing";

/**
 * Verifies Kintone webhook signature.
 * Kintone sends signature in 'X-Kintone-Signature' header.
 * The signature is HMAC-SHA256 of the raw request body.
 */
export function verifyKintoneSignature(
  body: string,
  signature: string,
  secret: string
): boolean {
  if (!body || !signature || !secret) return false;
  return verifySignature(body, signature, secret);
}
