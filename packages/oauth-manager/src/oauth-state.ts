/**
 * Shared OAuth state nonce generation and verification for CSRF protection.
 * State nonces expire after 10 minutes and are single-use.
 *
 * Storage is injected via the `StateStore` interface. The default is an
 * in-memory TTL store (single process). For multi-instance deployments,
 * inject a Redis/Firestore/Memcached-backed implementation.
 *
 * Ported from dev-dashboard-v2/server/lib/oauth-state.ts — the hard
 * dependency on the product's Redis cache layer (`cacheGet`/`cacheSet`/
 * `cacheDel`) was replaced by the injected `StateStore` interface.
 * The verification semantics are preserved exactly:
 *   - store hit  → type must match, nonce is deleted (one-time use)
 *   - store miss → fallback to type-only check (prevents login breakage
 *     on serverless / multi-instance without a shared store)
 */

/** Data stored per state nonce. */
export interface OAuthStateData {
  type: string;
  /** PKCE code_verifier associated with this authorization request (if any). */
  verifier?: string;
}

/** Minimal key-value store with TTL, used to persist state nonces. */
export interface StateStore {
  get(key: string): Promise<OAuthStateData | null>;
  set(key: string, value: OAuthStateData, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

export const STATE_TTL = 10 * 60 * 1000; // 10 minutes
const STATE_PREFIX = "oauth-state:";

/** TTL-aware in-memory StateStore (default; suitable for a single process). */
export class InMemoryStateStore implements StateStore {
  private readonly entries = new Map<string, { value: OAuthStateData; expiresAt: number }>();

  async get(key: string): Promise<OAuthStateData | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: OAuthStateData, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

const defaultStore: StateStore = new InMemoryStateStore();

/** Generate a CSRF-safe OAuth state parameter with nonce */
export async function generateOAuthState(
  type: string,
  store: StateStore = defaultStore,
  data?: { verifier?: string },
): Promise<string> {
  const nonce = crypto.randomUUID();
  await store.set(
    `${STATE_PREFIX}${nonce}`,
    { type, ...(data?.verifier ? { verifier: data.verifier } : {}) },
    STATE_TTL,
  );
  return JSON.stringify({ type, nonce });
}

/**
 * Consume an OAuth state parameter (one-time use).
 * Returns validity plus the stored PKCE verifier (when the flow used PKCE).
 * Falls back to type-only check on store miss (e.g., multi-instance without a
 * shared store). This is less strict but prevents login breakage on serverless.
 */
export async function consumeOAuthState(
  stateRaw: string,
  expectedType: string,
  store: StateStore = defaultStore,
): Promise<{ valid: boolean; verifier?: string }> {
  try {
    const parsed = JSON.parse(stateRaw) as { type: string; nonce?: string };
    if (!parsed.nonce) return { valid: false };
    // Try store-backed nonce verification first
    const stored = await store.get(`${STATE_PREFIX}${parsed.nonce}`);
    if (stored) {
      if (stored.type !== expectedType) return { valid: false };
      await store.del(`${STATE_PREFIX}${parsed.nonce}`); // One-time use
      return { valid: true, ...(stored.verifier ? { verifier: stored.verifier } : {}) };
    }
    // Fallback: store miss (no shared store, different instance). Verify type only.
    return { valid: parsed.type === expectedType };
  } catch {
    return { valid: false };
  }
}

/** Verify an OAuth state parameter. Returns true if valid (one-time use).
 * Falls back to type-only check when the store misses. */
export async function verifyOAuthState(
  stateRaw: string,
  expectedType: string,
  store: StateStore = defaultStore,
): Promise<boolean> {
  return (await consumeOAuthState(stateRaw, expectedType, store)).valid;
}
