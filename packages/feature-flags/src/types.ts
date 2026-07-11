/**
 * Shared types for @torihanaku/feature-flags.
 *
 * Ported from dev-dashboard-v2 server/lib/feature-flags.ts.
 * The product flag enum (FeatureFlags / FeatureFlagKey) is replaced by a
 * caller-supplied, string-keyed registry generic over the flag-key union.
 */

/**
 * Injected environment source. A plain record — the library never reads
 * process.env by itself (pass `processEnvSource()` to opt in).
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Definition of a single flag, supplied by the caller. */
export interface FlagDefinition {
  /** Human-readable label (UI fallback). Defaults to the flag key itself. */
  label?: string;
  /**
   * Env var names required to enable this flag
   * (surfaced by getRequiredVars / featureNotConfigured / getFlagDetails).
   */
  requiredVars?: string[];
  /** Compute the infra-level (env-derived) value from the injected env record. */
  enabled: (env: EnvSource) => boolean;
}

/** String-keyed flag registry, generic over the flag-key union. */
export type FlagRegistry<K extends string> = Record<K, FlagDefinition>;

/** One override row, mirroring `flag_key` / `enabled` columns of the source tables. */
export interface OverrideRecord {
  flagKey: string;
  enabled: boolean;
}

/**
 * Injected per-tenant / global override store.
 *
 * Mirrors the operations the source performed against the Supabase tables
 * `feature_flag_global_overrides` and `feature_flag_tenant_overrides`:
 * - list (SELECT flag_key, enabled) — used by flag resolution (60s TTL cache)
 * - upsert (POST with merge-duplicates + updated_by) / delete — used by the
 *   admin routes (write methods are optional; a read-only store is valid)
 *
 * Default when not injected: no overrides.
 */
export interface FlagOverrideStore {
  listGlobalOverrides(): Promise<OverrideRecord[]>;
  listTenantOverrides(tenantId: string): Promise<OverrideRecord[]>;
  upsertGlobalOverride?(flagKey: string, enabled: boolean, updatedBy: string): Promise<void>;
  deleteGlobalOverride?(flagKey: string): Promise<void>;
  upsertTenantOverride?(
    tenantId: string,
    flagKey: string,
    enabled: boolean,
    updatedBy: string,
  ): Promise<void>;
  deleteTenantOverride?(tenantId: string, flagKey: string): Promise<void>;
}

/** Audit trail event emitted on every override mutation. */
export interface FlagAuditEvent {
  action: "upsert" | "delete";
  scope: "global" | "tenant";
  flagKey: string;
  /** Present for upserts. */
  enabled?: boolean;
  /** Present for tenant-scoped mutations. */
  tenantId?: string;
  /** Actor identity; defaults to "unknown" (mirrors `updated_by: email || "unknown"`). */
  updatedBy: string;
  /** ISO-8601 timestamp (mirrors `changed_at: new Date().toISOString()`). */
  occurredAt: string;
}

/** Injectable audit sink. Default: no-op. */
export interface FlagAuditSink {
  record(event: FlagAuditEvent): void | Promise<void>;
}

/**
 * Optional per-tenant flag elevation (generalization of the source's
 * BYOK-derived flags: tenant-owned keys can turn ON flags that infra env vars
 * alone cannot enable). Results are cached per tenant with the same TTL.
 * The elevator is expected to handle its own errors (the source caught each
 * sub-lookup with `.catch(() => null)`).
 */
export type TenantElevator<K extends string> = (
  tenantId: string,
) => Promise<Partial<Record<K, boolean>>>;

/** Detailed flag info with all layers visible (port of FeatureFlagDetail). */
export interface FlagDetail<K extends string = string> {
  key: K;
  label: string;
  infra: boolean;
  globalOverride: boolean | null;
  tenantOverride: boolean | null;
  resolved: boolean;
  requiredVars: string[];
}

/** Constructor options for FeatureFlagClient. */
export interface FeatureFlagClientOptions<K extends string> {
  /** Flag definitions (caller-supplied registry). */
  flags: FlagRegistry<K>;
  /** Env record. Default: {} (all env-derived flags OFF unless their rule says otherwise). */
  env?: EnvSource;
  /** Override store. Default: none (no overrides). */
  overrides?: FlagOverrideStore;
  /** Audit sink for override mutations. Default: no-op. */
  audit?: FlagAuditSink;
  /** Per-tenant elevation. Default: none. */
  elevate?: TenantElevator<K>;
  /** Override/elevation cache TTL in ms. Default: 60_000 (source constant CACHE_TTL). */
  cacheTtlMs?: number;
}
