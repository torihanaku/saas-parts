/**
 * Hash-chain verifier (tamper-detection replayer).
 * Ported from 実運用SaaS `server/lib/audit-worm-exporter.ts`.
 *
 * Replays every entry of a tenant's audit log in `occurred_at` ascending
 * order, recomputing each entry hash from (prev_hash + canonical payload)
 * and checking chain linkage. Throws on the first inconsistency.
 */
import { createHash } from "node:crypto";
import type { AuditStore } from "./store";
import { canonicalPayload } from "./canonical";

const EMPTY = Buffer.alloc(0);

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Verify a tenant's audit-log hash chain.
 * @returns true if the chain is intact (or empty).
 * @throws Error "Hash chain broken ..." when prev_hash linkage is inconsistent,
 *         or "Hash mismatch ..." when a row's content does not match its entry_hash.
 */
export async function verifyHashChain(store: AuditStore, tenantId: string): Promise<boolean> {
  const entries = await store.listEntries(tenantId);
  if (!entries || entries.length === 0) return true;

  let expectedPrevHash: Buffer | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const prevHashBase64 = entry.prev_hash;
    const entryHashBase64 = entry.entry_hash;

    const actualPrevHash = prevHashBase64 ? Buffer.from(prevHashBase64, "base64") : null;
    const actualEntryHash = entryHashBase64 ? Buffer.from(entryHashBase64, "base64") : null;

    if (
      (expectedPrevHash === null && actualPrevHash !== null) ||
      (expectedPrevHash !== null && actualPrevHash === null) ||
      (expectedPrevHash !== null && actualPrevHash !== null && !expectedPrevHash.equals(actualPrevHash))
    ) {
      throw new Error(`Hash chain broken for tenant ${tenantId} at entry ${String(entry.id ?? i)}`);
    }

    const payload = canonicalPayload(entry);
    const calculatedHash = sha256(Buffer.concat([actualPrevHash ?? EMPTY, payload]));

    if (!actualEntryHash || !calculatedHash.equals(actualEntryHash)) {
      throw new Error(`Hash mismatch for tenant ${tenantId} at entry ${String(entry.id ?? i)}`);
    }

    expectedPrevHash = actualEntryHash;
  }
  return true;
}
