/**
 * PII hasher for attribution / dedup use-cases.
 *
 * Touchpoint stores keep `user_hash` (never the raw email). All ingest paths
 * SHOULD go through these helpers so there is a single entry point that writes
 * user hashes. SHA-256 is one-way; the same input yields the same hash so
 * callers can dedup without retaining PII.
 */

import { createHash } from "node:crypto";

/**
 * Hash an email address (case-insensitive, whitespace-trimmed) into a
 * SHA-256 hex digest suitable for a `user_hash` column.
 */
export function hashEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Generic PII hasher (phone, externally-supplied IDs). Does not lower-case so
 * the caller controls normalization for non-email values.
 */
export function hashPii(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
