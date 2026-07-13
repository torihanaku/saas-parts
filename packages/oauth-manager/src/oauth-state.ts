/**
 * Shared OAuth state nonce generation and verification for CSRF protection.
 * State nonces expire after 10 minutes and are single-use.
 *
 * Storage is injected via the `StateStore` interface. The default is an
 * in-memory TTL store (single process). For multi-instance deployments,
 * inject a Redis/Firestore/Memcached-backed implementation.
 *
 * Ported from 実運用SaaS/server/lib/oauth-state.ts — the hard
 * dependency on the product's Redis cache layer (`cacheGet`/`cacheSet`/
 * `cacheDel`) was replaced by the injected `StateStore` interface.
 *
 * SECURITY (2026-07 hardening): the original port fell back to a *type-only*
 * check on store miss ("prevents login breakage on serverless"). That fallback
 * is a CSRF bypass: the `type` (provider name, e.g. "slack"/"github") is public
 * and guessable, so an attacker can forge a state with any random nonce and it
 * is accepted — and PKCE is silently dropped because no verifier is returned.
 * The store-miss fallback is now **off by default** (secure). Deployments that
 * genuinely lack a shared store may opt back in via
 * `{ allowStoreMissFallback: true }`, but the correct fix is to inject a shared
 * StateStore (Redis/Firestore/Memcached).
 *
 * Verification semantics:
 *   - store hit  → type must match, nonce is deleted (one-time use)
 *   - store miss → INVALID by default (opt-in type-only fallback available)
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

/** Options for state consumption / verification. */
export interface ConsumeOAuthStateOptions {
  /**
   * When the nonce is not found in the store, fall back to a type-only check.
   * DEFAULT `false` (secure): a store miss is treated as INVALID, because the
   * `type` is public/guessable and a type-only pass lets an attacker forge a
   * state (CSRF bypass) and also silently drops PKCE. Only enable this if you
   * knowingly run without a shared StateStore and accept the weaker guarantee.
   */
  allowStoreMissFallback?: boolean;
}

/**
 * Consume an OAuth state parameter (one-time use).
 * Returns validity plus the stored PKCE verifier (when the flow used PKCE).
 *
 * A store miss is INVALID by default. See `ConsumeOAuthStateOptions` /
 * `allowStoreMissFallback` for the (discouraged) legacy fallback.
 */
export async function consumeOAuthState(
  stateRaw: string,
  expectedType: string,
  store: StateStore = defaultStore,
  options: ConsumeOAuthStateOptions = {},
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
    // Store miss. Secure default: reject. The type is public and guessable, so
    // accepting on a type-only match would defeat CSRF protection and drop PKCE.
    if (options.allowStoreMissFallback) {
      return { valid: parsed.type === expectedType };
    }
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

/** Verify an OAuth state parameter. Returns true if valid (one-time use).
 * A store miss is INVALID by default; see `allowStoreMissFallback`. */
export async function verifyOAuthState(
  stateRaw: string,
  expectedType: string,
  store: StateStore = defaultStore,
  options: ConsumeOAuthStateOptions = {},
): Promise<boolean> {
  return (await consumeOAuthState(stateRaw, expectedType, store, options)).valid;
}
