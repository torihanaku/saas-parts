/**
 * Canonical JSON for the audit hash chain — shared by the logger (audit.ts) and
 * the verifier (verify.ts) so the two can NEVER drift.
 *
 * Why not `JSON.stringify(obj, Object.keys(obj).sort())`? Passing a key array as
 * the replacer is applied *recursively* to every nested object, so nested keys
 * that don't appear at the top level are silently dropped. That meant the old
 * chain did NOT cover the contents of `changes` — an attacker could rewrite
 * `changes.amount` and the hash still matched. This canonicalizer walks the whole
 * tree, sorts keys at every depth, and includes every value.
 *
 * Normalization also makes DB round-trips stable: Buffer/Uint8Array → base64,
 * Date → ISO string. So a bytea column read back as a base64 string hashes the
 * same as the in-memory Buffer that produced it.
 */

/** Fields that are added AFTER hashing and must be excluded from the payload. */
const META_KEYS = new Set(["id", "prev_hash", "entry_hash"]);

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;

  // Byte payloads → base64 so Buffer and its base64 round-trip hash identically.
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = normalize(obj[key]);
  }
  return out;
}

/**
 * Canonical byte payload for a log entry, EXCLUDING chain-metadata columns
 * (`id` / `prev_hash` / `entry_hash`). Deterministic across insert and verify.
 */
export function canonicalPayload(obj: Record<string, unknown>): Buffer {
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!META_KEYS.has(key)) filtered[key] = obj[key];
  }
  return Buffer.from(JSON.stringify(normalize(filtered)));
}
