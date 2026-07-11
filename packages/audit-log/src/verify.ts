/**
 * Hash-chain verifier (tamper-detection replayer).
 * Ported from dev-dashboard-v2 `server/lib/audit-worm-exporter.ts`.
 *
 * Replays every entry of a tenant's audit log in `occurred_at` ascending
 * order, recomputing each entry hash from (prev_hash + canonical payload)
 * and checking chain linkage. Throws on the first inconsistency.
 */
import { createHash } from "node:crypto";
import type { AuditStore } from "./store";

const EMPTY = Buffer.alloc(0);

/**
 * Verifier-side canonical JSON — EXACTLY as in the source: strips
 * `id` / `prev_hash` / `entry_hash`, then stringifies the rest with its
 * sorted keys as the replacer array. Keep byte-identical to the logger side.
 */
function canonicalJson(obj: Record<string, unknown>): Buffer {
  const { id: _id, prev_hash: _prev_hash, entry_hash: _entry_hash, ...rest } = obj;
  return Buffer.from(JSON.stringify(rest, Object.keys(rest).sort()));
}

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

    const payload = canonicalJson(entry);
    const calculatedHash = sha256(Buffer.concat([actualPrevHash ?? EMPTY, payload]));

    if (!actualEntryHash || !calculatedHash.equals(actualEntryHash)) {
      throw new Error(`Hash mismatch for tenant ${tenantId} at entry ${String(entry.id ?? i)}`);
    }

    expectedPrevHash = actualEntryHash;
  }
  return true;
}
