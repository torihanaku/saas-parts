/**
 * Feature flag client — env-derived flags + global/tenant override layers
 * + optional per-tenant elevation + audit trail.
 *
 * Port of 実運用SaaS server/lib/feature-flags.ts (flag computation,
 * override caches, resolution precedence, details, canary helper,
 * featureNotConfigured) and the override-mutation behavior of
 * server/routes/feature-flag-overrides.ts (upsert/delete → cache clear →
 * audit), decoupled from env / Supabase / the project audit module via
 * injected interfaces.
 *
 * Resolution precedence (unchanged from the source):
 *   resolved = (infra AND globalOverride AND tenantOverride) OR elevated
 * where unset overrides default to true (no effect), and unknown flag keys
 * resolve to false (safe default OFF).
 */

import type {
  EnvSource,
  FeatureFlagClientOptions,
  FlagAuditSink,
  FlagDefinition,
  FlagDetail,
  FlagOverrideStore,
  FlagRegistry,
  TenantElevator,
} from "./types";

const DEFAULT_CACHE_TTL = 60_000;

/** No-op audit sink (default). */
const NOOP_AUDIT: FlagAuditSink = { record: () => {} };

/** Helper to define a registry with full key-union type inference. */
export function defineFlags<K extends string>(flags: FlagRegistry<K>): FlagRegistry<K> {
  return flags;
}

/**
 * Opt-in helper for using the real process.env as the env source.
 * The default path never touches process.env.
 */
export function processEnvSource(): EnvSource {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

export class FeatureFlagClient<K extends string> {
  private readonly registry: FlagRegistry<K>;
  private readonly env: EnvSource;
  private readonly store: FlagOverrideStore | undefined;
  private readonly audit: FlagAuditSink;
  private readonly elevate: TenantElevator<K> | undefined;
  private readonly cacheTtlMs: number;

  // ─── Caches (mirror the module-level caches of the source) ────────────────
  private cachedFlags: Record<K, boolean> | null = null;
  private globalOverridesCache: { data: Map<string, boolean>; fetchedAt: number } | null = null;
  private readonly tenantOverridesCache = new Map<
    string,
    { data: Map<string, boolean>; fetchedAt: number }
  >();
  private readonly elevationCache = new Map<
    string,
    { flags: Partial<Record<K, boolean>>; fetchedAt: number }
  >();

  constructor(options: FeatureFlagClientOptions<K>) {
    this.registry = options.flags;
    this.env = options.env ?? {};
    this.store = options.overrides;
    this.audit = options.audit ?? NOOP_AUDIT;
    this.elevate = options.elevate;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL;
  }

  // ─── Flag Computation (port of computeFlags/getFeatureFlags/isEnabled) ────

  private flagKeys(): K[] {
    return Object.keys(this.registry) as K[];
  }

  private lookup(flag: string): FlagDefinition | undefined {
    return (this.registry as Record<string, FlagDefinition | undefined>)[flag];
  }

  private computeFlags(): Record<K, boolean> {
    const flags = {} as Record<K, boolean>;
    for (const key of this.flagKeys()) {
      const def = this.lookup(key);
      flags[key] = def ? def.enabled(this.env) : false;
    }
    return flags;
  }

  /** Get all env-derived (infra) flags. Cached after first call. */
  getFlags(): Record<K, boolean> {
    if (!this.cachedFlags) this.cachedFlags = this.computeFlags();
    return this.cachedFlags;
  }

  /**
   * Check if a specific feature is enabled at the infra (env) layer.
   * Unknown flags are OFF (safe default).
   */
  isEnabled(flag: K): boolean {
    return this.getFlags()[flag] ?? false;
  }

  /** Reset cached flags (for testing or after env changes). */
  reset(): void {
    this.cachedFlags = null;
  }

  /** Get required env vars for a flag. Unknown flags → []. */
  getRequiredVars(flag: K): string[] {
    return this.lookup(flag)?.requiredVars || [];
  }

  /** Get human-readable label for a flag. Unknown / unlabeled flags → the key itself. */
  getLabel(flag: K): string {
    return this.lookup(flag)?.label || flag;
  }

  /** Return 501 response for unconfigured features. */
  featureNotConfigured(flag: K): Response {
    const requiredVars = this.getRequiredVars(flag);
    return new Response(
      JSON.stringify({
        error: "feature_not_configured",
        feature: flag,
        message: `This feature requires the following environment variables: ${requiredVars.join(", ")}`,
      }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }

  // ─── Override Layer (port of the Supabase-backed cached layer) ────────────

  /** Clear global overrides cache (call after write). */
  clearGlobalOverridesCache(): void {
    this.globalOverridesCache = null;
  }

  /** Clear tenant overrides cache for a specific tenant (call after write). */
  clearTenantOverridesCache(tenantId: string): void {
    this.tenantOverridesCache.delete(tenantId);
  }

  /** Fetch global overrides from the injected store, cached with TTL. */
  async getGlobalOverrides(): Promise<Map<string, boolean>> {
    if (
      this.globalOverridesCache &&
      Date.now() - this.globalOverridesCache.fetchedAt < this.cacheTtlMs
    ) {
      return this.globalOverridesCache.data;
    }
    const map = new Map<string, boolean>();
    // Mirrors the source's `if (!SUPABASE_URL || !SUPABASE_KEY) return map;`
    // (no store configured → no overrides, and nothing is cached).
    if (!this.store) return map;
    try {
      const rows = await this.store.listGlobalOverrides();
      for (const row of rows) map.set(row.flagKey, row.enabled);
    } catch (e) {
      console.error("[feature-flags] global overrides fetch error:", e);
    }
    this.globalOverridesCache = { data: map, fetchedAt: Date.now() };
    return map;
  }

  /** Fetch tenant overrides from the injected store, cached per tenantId with TTL. */
  async getTenantOverrides(tenantId: string): Promise<Map<string, boolean>> {
    const cached = this.tenantOverridesCache.get(tenantId);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.data;
    }
    const map = new Map<string, boolean>();
    if (!this.store) return map;
    try {
      const rows = await this.store.listTenantOverrides(tenantId);
      for (const row of rows) map.set(row.flagKey, row.enabled);
    } catch (e) {
      console.error("[feature-flags] tenant overrides fetch error:", e);
    }
    this.tenantOverridesCache.set(tenantId, { data: map, fetchedAt: Date.now() });
    return map;
  }

  // ─── Elevation (generalized port of the BYOK-derived flags layer) ─────────

  private async getElevatedFlags(tenantId: string): Promise<Partial<Record<K, boolean>>> {
    if (!this.elevate) return {};
    const cached = this.elevationCache.get(tenantId);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) return cached.flags;

    const flags = await this.elevate(tenantId);
    this.elevationCache.set(tenantId, { flags, fetchedAt: Date.now() });
    return flags;
  }

  /** Clear elevation cache for a specific tenant (call after tenant key changes). */
  clearElevationCache(tenantId: string): void {
    this.elevationCache.delete(tenantId);
  }

  // ─── Resolution (port of resolveFeatureFlags) ─────────────────────────────

  /**
   * Resolve feature flags with override layers.
   * Resolution: (infra AND globalOverride AND tenantOverride) OR elevated
   * Tenant elevation can turn ON flags that infra env vars alone cannot enable.
   */
  async resolveFlags(tenantId?: string): Promise<Record<K, boolean>> {
    const infra = this.getFlags();
    const globalOverrides = await this.getGlobalOverrides();
    const tenantOverrides = tenantId
      ? await this.getTenantOverrides(tenantId)
      : new Map<string, boolean>();

    const resolved = { ...infra };
    for (const key of Object.keys(infra) as K[]) {
      const globalVal = globalOverrides.get(key) ?? true;
      const tenantVal = tenantOverrides.get(key) ?? true;
      resolved[key] = (infra[key] ?? false) && globalVal && tenantVal;
    }

    if (tenantId) {
      const elevated = await this.getElevatedFlags(tenantId);
      for (const [k, v] of Object.entries(elevated)) {
        // Only known flags can be elevated (unknown keys stay OFF).
        if (v && this.lookup(k)) resolved[k as K] = true;
      }
    }

    return resolved;
  }

  /** Get detailed flag info with all layers visible (port of getFeatureFlagDetails). */
  async getFlagDetails(tenantId?: string): Promise<FlagDetail<K>[]> {
    const infra = this.getFlags();
    const globalOverrides = await this.getGlobalOverrides();
    const tenantOverrides = tenantId
      ? await this.getTenantOverrides(tenantId)
      : new Map<string, boolean>();

    return this.flagKeys().map((key) => {
      const infraVal = infra[key] ?? false;
      const globalVal = globalOverrides.has(key) ? globalOverrides.get(key)! : null;
      const tenantVal = tenantOverrides.has(key) ? tenantOverrides.get(key)! : null;
      const resolved = infraVal && (globalVal ?? true) && (tenantVal ?? true);

      return {
        key,
        label: this.getLabel(key),
        infra: infraVal,
        globalOverride: globalVal,
        tenantOverride: tenantVal,
        resolved,
        requiredVars: this.getRequiredVars(key),
      };
    });
  }

  // ─── Canary (generalized port of isAutonomousAgentEnabled etc.) ───────────

  /**
   * Per-tenant canary check: if `canaryEnvVar` holds a non-empty
   * comma-separated tenant-ID list, only listed tenants get the flag;
   * otherwise falls back to the infra flag value.
   */
  isCanaryEnabled(flag: K, tenantId: string, canaryEnvVar: string): boolean {
    const canary = (this.env[canaryEnvVar] ?? "").split(",").filter(Boolean);
    if (canary.length > 0) return canary.includes(tenantId);
    return this.isEnabled(flag);
  }

  // ─── Override mutations (port of routes/feature-flag-overrides.ts behavior:
  //     write → clear cache → audit trail) ────────────────────────────────────

  private requireStore(
    method: keyof FlagOverrideStore,
  ): FlagOverrideStore {
    if (!this.store || typeof this.store[method] !== "function") {
      throw new Error(`[feature-flags] override store does not support ${String(method)}`);
    }
    return this.store;
  }

  /** Upsert a global override, invalidate cache, record audit event. */
  async setGlobalOverride(flag: K, enabled: boolean, updatedBy?: string): Promise<void> {
    const store = this.requireStore("upsertGlobalOverride");
    const by = updatedBy || "unknown";
    await store.upsertGlobalOverride!(flag, enabled, by);
    this.clearGlobalOverridesCache();
    await this.audit.record({
      action: "upsert",
      scope: "global",
      flagKey: flag,
      enabled,
      updatedBy: by,
      occurredAt: new Date().toISOString(),
    });
  }

  /** Delete a global override, invalidate cache, record audit event. */
  async removeGlobalOverride(flag: K, updatedBy?: string): Promise<void> {
    const store = this.requireStore("deleteGlobalOverride");
    const by = updatedBy || "unknown";
    await store.deleteGlobalOverride!(flag);
    this.clearGlobalOverridesCache();
    await this.audit.record({
      action: "delete",
      scope: "global",
      flagKey: flag,
      updatedBy: by,
      occurredAt: new Date().toISOString(),
    });
  }

  /** Upsert a tenant override, invalidate that tenant's cache, record audit event. */
  async setTenantOverride(
    tenantId: string,
    flag: K,
    enabled: boolean,
    updatedBy?: string,
  ): Promise<void> {
    const store = this.requireStore("upsertTenantOverride");
    const by = updatedBy || "unknown";
    await store.upsertTenantOverride!(tenantId, flag, enabled, by);
    this.clearTenantOverridesCache(tenantId);
    await this.audit.record({
      action: "upsert",
      scope: "tenant",
      flagKey: flag,
      enabled,
      tenantId,
      updatedBy: by,
      occurredAt: new Date().toISOString(),
    });
  }

  /** Delete a tenant override, invalidate that tenant's cache, record audit event. */
  async removeTenantOverride(tenantId: string, flag: K, updatedBy?: string): Promise<void> {
    const store = this.requireStore("deleteTenantOverride");
    const by = updatedBy || "unknown";
    await store.deleteTenantOverride!(tenantId, flag);
    this.clearTenantOverridesCache(tenantId);
    await this.audit.record({
      action: "delete",
      scope: "tenant",
      flagKey: flag,
      tenantId,
      updatedBy: by,
      occurredAt: new Date().toISOString(),
    });
  }
}
