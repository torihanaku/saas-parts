/**
 * Purpose-based consent guard with a 60s in-memory cache and a
 * revocation cascade (which dependent rows to purge per purpose is
 * injected as config or callback).
 *
 * Ported from dev-dashboard-v2 `server/lib/consent-guard.ts`.
 * hasConsent/requireConsent/invalidateConsentCache preserve the source
 * behavior (fail-closed on store errors, 60s TTL cache); grant/revoke
 * mirror the source's `/api/consent` route operations.
 */
import type { ConsentStore, ConsentStoreResult } from "./store";
import { ConsentMissingError, type ConsentBasis } from "./types";
import type { ExampleConsentPurpose } from "./types";

/** Source value: 60 seconds. */
const DEFAULT_CACHE_TTL_MS = 60 * 1000;

interface CacheEntry {
  granted: boolean;
  expiresAt: number;
}

export interface ConsentRevocationResult {
  table: string;
  ok: boolean;
  detail?: string;
}

/** One purge target of the revocation cascade. `tenant_id` filter is always applied. */
export interface CascadePurgeTarget {
  table: string;
  /** Extra equality filters (source: `source_type=eq.slack` etc.). */
  filters?: Record<string, string>;
}

/** purpose → tables to purge when that purpose is revoked. */
export type RevocationCascadeMap<TPurpose extends string = string> = Partial<
  Record<TPurpose, CascadePurgeTarget[]>
>;

/**
 * The source (COS) cascade mapping, kept as a documented example
 * (table names de-prefixed):
 * - umbrella purpose purges every cos_* table for the tenant
 * - per-source purposes purge digest items by source_type
 *   (in the source, FK ON DELETE CASCADE then removed extracted tasks).
 */
export const EXAMPLE_COS_REVOCATION_CASCADE: RevocationCascadeMap<ExampleConsentPurpose> = {
  external_data_processing: [
    { table: "cos_extracted_tasks" },
    { table: "cos_digest_items" },
    { table: "cos_briefings" },
  ],
  slack_content_analysis: [{ table: "cos_digest_items", filters: { source_type: "slack" } }],
  email_content_analysis: [{ table: "cos_digest_items", filters: { source_type: "email" } }],
  meeting_transcript_analysis: [{ table: "cos_digest_items", filters: { source_type: "meeting" } }],
};

export interface ConsentGuardOptions<TPurpose extends string = string> {
  store: ConsentStore;
  /** Cache TTL. Source: 60,000ms. */
  cacheTtlMs?: number;
  /**
   * Revocation cascade — either a declarative map (purged via
   * `store.deleteRows`, tenant-scoped) or a fully custom callback.
   */
  revocationCascade?:
    | RevocationCascadeMap<TPurpose>
    | ((tenantId: string, purpose: TPurpose) => Promise<ConsentRevocationResult[]>);
  /** Error sink for fail-closed consent checks. Default: console.error (source behavior). */
  onError?: (message: string, error: unknown) => void;
  /** Structured-log sink for cascade propagation. Default: console.warn (source behavior). */
  log?: (line: string) => void;
}

export interface ConsentGuard<TPurpose extends string = string> {
  /** Check consent (60s TTL cache; fail-closed → false on store errors). */
  hasConsent(userId: string, tenantId: string, purpose: TPurpose): Promise<boolean>;
  /** Throw ConsentMissingError unless consent is granted. */
  requireConsent(userId: string, tenantId: string, purpose: TPurpose): Promise<void>;
  /** Manually invalidate the cache entry (call after grant/revoke via other paths). */
  invalidateConsentCache(userId: string, tenantId: string, purpose: TPurpose): void;
  /** Record a grant and invalidate the cache. */
  grantConsent(
    tenantId: string,
    userId: string,
    purpose: TPurpose,
    basis: ConsentBasis,
  ): Promise<ConsentStoreResult>;
  /** Revoke, invalidate the cache, then propagate the revocation cascade. */
  revokeConsent(
    tenantId: string,
    userId: string,
    purpose: TPurpose,
  ): Promise<ConsentStoreResult & { cascade: ConsentRevocationResult[] }>;
  /**
   * Propagate a consent revocation to dependent data.
   * Idempotent — safe to retry. Errors are reported per table and do not
   * throw, so a single table failure doesn't block other deletions.
   */
  onConsentRevoked(tenantId: string, purpose: TPurpose): Promise<ConsentRevocationResult[]>;
}

export function createConsentGuard<TPurpose extends string = string>(
  options: ConsentGuardOptions<TPurpose>,
): ConsentGuard<TPurpose> {
  const { store, revocationCascade } = options;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const onError =
    options.onError ?? ((message, error) => console.error(`[ConsentGuard] ${message}`, error));
  const log = options.log ?? ((line) => console.warn(line));

  const consentCache = new Map<string, CacheEntry>();

  async function hasConsent(
    userId: string,
    tenantId: string,
    purpose: TPurpose,
  ): Promise<boolean> {
    const cacheKey = `${tenantId}:${userId}:${purpose}`;
    const now = Date.now();
    const cached = consentCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.granted;
    }

    try {
      const granted = await store.hasActiveConsent(tenantId, userId, purpose);

      consentCache.set(cacheKey, {
        granted,
        expiresAt: now + cacheTtlMs,
      });

      return granted;
    } catch (error) {
      onError("Error checking consent:", error);
      return false;
    }
  }

  async function requireConsent(
    userId: string,
    tenantId: string,
    purpose: TPurpose,
  ): Promise<void> {
    if (!(await hasConsent(userId, tenantId, purpose))) {
      throw new ConsentMissingError(purpose);
    }
  }

  function invalidateConsentCache(userId: string, tenantId: string, purpose: TPurpose): void {
    const cacheKey = `${tenantId}:${userId}:${purpose}`;
    consentCache.delete(cacheKey);
  }

  async function onConsentRevoked(
    tenantId: string,
    purpose: TPurpose,
  ): Promise<ConsentRevocationResult[]> {
    if (!revocationCascade) return [];

    let results: ConsentRevocationResult[];

    if (typeof revocationCascade === "function") {
      results = await revocationCascade(tenantId, purpose);
    } else {
      const targets = revocationCascade[purpose];
      if (!targets || targets.length === 0) return [];
      results = [];
      for (const target of targets) {
        const r = await store.deleteRows(target.table, {
          tenant_id: tenantId,
          ...target.filters,
        });
        results.push({ table: target.table, ok: r.ok, detail: r.error });
      }
    }

    log(
      JSON.stringify({
        severity: "INFO",
        message: "consent_revoke_propagated",
        tenant_id: tenantId,
        purpose,
        results,
      }),
    );

    return results;
  }

  async function grantConsent(
    tenantId: string,
    userId: string,
    purpose: TPurpose,
    basis: ConsentBasis,
  ): Promise<ConsentStoreResult> {
    const result = await store.grant({
      tenantId,
      userId,
      purpose,
      basis,
      grantedAt: new Date().toISOString(),
      revokedAt: null,
    });
    invalidateConsentCache(userId, tenantId, purpose);
    return result;
  }

  async function revokeConsent(
    tenantId: string,
    userId: string,
    purpose: TPurpose,
  ): Promise<ConsentStoreResult & { cascade: ConsentRevocationResult[] }> {
    const result = await store.revoke(tenantId, userId, purpose, new Date().toISOString());
    invalidateConsentCache(userId, tenantId, purpose);
    const cascade = result.ok ? await onConsentRevoked(tenantId, purpose) : [];
    return { ...result, cascade };
  }

  return {
    hasConsent,
    requireConsent,
    invalidateConsentCache,
    grantConsent,
    revokeConsent,
    onConsentRevoked,
  };
}
