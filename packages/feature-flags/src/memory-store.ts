/**
 * In-memory reference implementation of FlagOverrideStore.
 * Useful for tests and as a template for real adapters (e.g. a Supabase REST
 * adapter mirroring feature_flag_global_overrides / feature_flag_tenant_overrides).
 */

import type { FlagOverrideStore, OverrideRecord } from "./types";

export class InMemoryOverrideStore implements FlagOverrideStore {
  private readonly global = new Map<string, boolean>();
  private readonly tenants = new Map<string, Map<string, boolean>>();

  async listGlobalOverrides(): Promise<OverrideRecord[]> {
    return [...this.global].map(([flagKey, enabled]) => ({ flagKey, enabled }));
  }

  async listTenantOverrides(tenantId: string): Promise<OverrideRecord[]> {
    const map = this.tenants.get(tenantId);
    return map ? [...map].map(([flagKey, enabled]) => ({ flagKey, enabled })) : [];
  }

  async upsertGlobalOverride(flagKey: string, enabled: boolean): Promise<void> {
    this.global.set(flagKey, enabled);
  }

  async deleteGlobalOverride(flagKey: string): Promise<void> {
    this.global.delete(flagKey);
  }

  async upsertTenantOverride(tenantId: string, flagKey: string, enabled: boolean): Promise<void> {
    let map = this.tenants.get(tenantId);
    if (!map) {
      map = new Map();
      this.tenants.set(tenantId, map);
    }
    map.set(flagKey, enabled);
  }

  async deleteTenantOverride(tenantId: string, flagKey: string): Promise<void> {
    this.tenants.get(tenantId)?.delete(flagKey);
  }
}
