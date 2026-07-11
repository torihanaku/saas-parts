/**
 * Ported core tests.
 * Origin:
 * - dev-dashboard-v2/tests/feature-flag-overrides.test.ts
 *     (resolution precedence, override caches, cache invalidation, details, labels)
 * - dev-dashboard-v2/tests/feature-flags-byok.test.ts
 *     (tenant elevation + elevation cache, regression guard)
 * - dev-dashboard-v2/tests/white-label-flag.test.ts
 *     (env "true" toggle, requiredVars, label, isEnabled)
 * Product flags are renamed to generic examples ('new-dashboard', 'beta-export', ...).
 * Product-specific suites (route-availability, namespaces) are intentionally dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FeatureFlagClient,
  InMemoryOverrideStore,
  defineFlags,
  type FlagAuditEvent,
  type FlagOverrideStore,
} from "./index";

// Generic registry mirroring the source's env-derivation patterns:
// key presence (ai/slack style), "true" toggle (whiteLabel style), always-on.
const FLAGS = defineFlags({
  "new-dashboard": {
    label: "New Dashboard",
    requiredVars: ["NEW_DASHBOARD_API_KEY"],
    enabled: (env) => !!env.NEW_DASHBOARD_API_KEY,
  },
  "beta-export": {
    label: "Beta Export",
    requiredVars: ["ENABLE_BETA_EXPORT"],
    enabled: (env) => env.ENABLE_BETA_EXPORT === "true",
  },
  "combo-feature": {
    label: "Combo Feature",
    requiredVars: ["COMBO_CLIENT_ID", "COMBO_CLIENT_SECRET"],
    enabled: (env) => !!(env.COMBO_CLIENT_ID && env.COMBO_CLIENT_SECRET),
  },
  "always-on": {
    requiredVars: [],
    enabled: () => true,
  },
});

type Key = keyof typeof FLAGS;

const FULL_ENV = {
  NEW_DASHBOARD_API_KEY: "test-key",
  ENABLE_BETA_EXPORT: "true",
  COMBO_CLIENT_ID: "combo-id",
  COMBO_CLIENT_SECRET: "combo-secret",
};

function mockStore(overrides: Partial<FlagOverrideStore> = {}): FlagOverrideStore {
  return {
    listGlobalOverrides: vi.fn().mockResolvedValue([]),
    listTenantOverrides: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Env-derived flags (port of white-label-flag.test.ts patterns) ───────────

describe("env-derived flags", () => {
  it("'true' toggle flag is ON when env var is 'true'", () => {
    const client = new FeatureFlagClient({ flags: FLAGS, env: { ENABLE_BETA_EXPORT: "true" } });
    expect(client.isEnabled("beta-export")).toBe(true);
  });

  it("'true' toggle flag is OFF when env var is missing or another value", () => {
    expect(new FeatureFlagClient({ flags: FLAGS, env: {} }).isEnabled("beta-export")).toBe(false);
    expect(
      new FeatureFlagClient({ flags: FLAGS, env: { ENABLE_BETA_EXPORT: "1" } }).isEnabled(
        "beta-export",
      ),
    ).toBe(false);
  });

  it("presence-based flag follows env var presence", () => {
    const on = new FeatureFlagClient({ flags: FLAGS, env: { NEW_DASHBOARD_API_KEY: "k" } });
    const off = new FeatureFlagClient({ flags: FLAGS, env: {} });
    expect(on.isEnabled("new-dashboard")).toBe(true);
    expect(off.isEnabled("new-dashboard")).toBe(false);
  });

  it("combo flag requires all env vars", () => {
    const partial = new FeatureFlagClient({ flags: FLAGS, env: { COMBO_CLIENT_ID: "id" } });
    expect(partial.isEnabled("combo-feature")).toBe(false);
    const full = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV });
    expect(full.isEnabled("combo-feature")).toBe(true);
  });

  it("env defaults to an empty record (process.env is never read implicitly)", () => {
    process.env.ENABLE_BETA_EXPORT = "true";
    try {
      const client = new FeatureFlagClient({ flags: FLAGS });
      expect(client.isEnabled("beta-export")).toBe(false);
    } finally {
      delete process.env.ENABLE_BETA_EXPORT;
    }
  });

  it("getRequiredVars exposes required env vars; unknown flag → []", () => {
    const client = new FeatureFlagClient({ flags: FLAGS, env: {} });
    expect(client.getRequiredVars("beta-export")).toContain("ENABLE_BETA_EXPORT");
    expect(client.getRequiredVars("always-on")).toEqual([]);
    expect(client.getRequiredVars("nope" as Key)).toEqual([]);
  });

  it("getLabel returns the label, or the key itself as fallback", () => {
    const client = new FeatureFlagClient({ flags: FLAGS, env: {} });
    expect(client.getLabel("new-dashboard")).toBe("New Dashboard");
    expect(client.getLabel("always-on")).toBe("always-on");
    expect(client.getLabel("nope" as Key)).toBe("nope");
  });

  it("flags are cached after first call; reset() forces recompute", () => {
    const spy = vi.fn().mockReturnValue(true);
    const client = new FeatureFlagClient({
      flags: defineFlags({ spy: { enabled: spy } }),
      env: {},
    });
    client.isEnabled("spy");
    client.isEnabled("spy");
    expect(spy).toHaveBeenCalledTimes(1);
    client.reset();
    client.isEnabled("spy");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// ─── Safe default OFF for unknown flags ───────────────────────────────────────

describe("safe default OFF for unknown flags", () => {
  it("isEnabled returns false for a flag not in the registry", () => {
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV });
    expect(client.isEnabled("totally-unknown" as Key)).toBe(false);
  });

  it("elevation cannot turn ON an unknown flag", async () => {
    const client = new FeatureFlagClient({
      flags: FLAGS,
      env: {},
      elevate: async () => ({ "totally-unknown": true }) as never,
    });
    const flags = await client.resolveFlags("tenant-1");
    expect((flags as Record<string, boolean>)["totally-unknown"]).toBeUndefined();
  });
});

// ─── resolveFlags precedence (port of "resolveFeatureFlags" suite) ────────────

describe("resolveFlags", () => {
  it("returns all true when infra flags true and no overrides", async () => {
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: mockStore() });
    const flags = await client.resolveFlags();
    expect(flags["new-dashboard"]).toBe(true);
    expect(flags["beta-export"]).toBe(true);
    expect(flags["combo-feature"]).toBe(true);
    expect(flags["always-on"]).toBe(true);
  });

  it("infra false wins even when global override is true", async () => {
    // combo-feature requires COMBO_* vars which are absent
    const store = mockStore({
      listGlobalOverrides: vi.fn().mockResolvedValue([{ flagKey: "combo-feature", enabled: true }]),
    });
    const client = new FeatureFlagClient({
      flags: FLAGS,
      env: { NEW_DASHBOARD_API_KEY: "k" },
      overrides: store,
    });
    expect(client.getFlags()["combo-feature"]).toBe(false);
    const flags = await client.resolveFlags();
    expect(flags["combo-feature"]).toBe(false);
  });

  it("global override false disables an infra-true flag", async () => {
    const store = mockStore({
      listGlobalOverrides: vi
        .fn()
        .mockResolvedValue([{ flagKey: "new-dashboard", enabled: false }]),
    });
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: store });
    const flags = await client.resolveFlags();
    expect(flags["new-dashboard"]).toBe(false);
  });

  it("tenant override false disables an infra-true + global-true flag", async () => {
    const store = mockStore({
      listTenantOverrides: vi
        .fn()
        .mockResolvedValue([{ flagKey: "new-dashboard", enabled: false }]),
    });
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: store });
    const flags = await client.resolveFlags("tenant-1");
    expect(flags["new-dashboard"]).toBe(false);
  });

  it("unset overrides default to true (no effect)", async () => {
    const store = mockStore({
      listGlobalOverrides: vi.fn().mockResolvedValue([{ flagKey: "beta-export", enabled: false }]),
    });
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: store });
    const flags = await client.resolveFlags();
    expect(flags["new-dashboard"]).toBe(true);
    expect(flags["beta-export"]).toBe(false);
  });

  it("all three layers must be true for resolved=true", async () => {
    const store = mockStore({
      listGlobalOverrides: vi.fn().mockResolvedValue([{ flagKey: "beta-export", enabled: true }]),
      listTenantOverrides: vi.fn().mockResolvedValue([{ flagKey: "beta-export", enabled: false }]),
    });
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: store });
    const flags = await client.resolveFlags("tenant-2");
    expect(flags["beta-export"]).toBe(false);
  });

  it("without tenantId, skips tenant overrides fetch", async () => {
    const store = mockStore();
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: store });
    await client.resolveFlags();
    expect(store.listGlobalOverrides).toHaveBeenCalledTimes(1);
    expect(store.listTenantOverrides).not.toHaveBeenCalled();
  });

  it("without an override store, resolves from infra only", async () => {
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV });
    const flags = await client.resolveFlags("tenant-1");
    expect(flags["new-dashboard"]).toBe(true);
    expect(flags["always-on"]).toBe(true);
  });
});

// ─── getFlagDetails (port of "getFeatureFlagDetails" suite) ───────────────────

describe("getFlagDetails", () => {
  it("returns detail objects with all layer values", async () => {
    const store = mockStore({
      listGlobalOverrides: vi
        .fn()
        .mockResolvedValue([{ flagKey: "new-dashboard", enabled: false }]),
      listTenantOverrides: vi.fn().mockResolvedValue([{ flagKey: "beta-export", enabled: false }]),
    });
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: store });
    const details = await client.getFlagDetails("tenant-1");

    const nd = details.find((d) => d.key === "new-dashboard")!;
    expect(nd.infra).toBe(true);
    expect(nd.globalOverride).toBe(false);
    expect(nd.tenantOverride).toBe(null);
    expect(nd.resolved).toBe(false);

    const be = details.find((d) => d.key === "beta-export")!;
    expect(be.globalOverride).toBe(null);
    expect(be.tenantOverride).toBe(false);
    expect(be.resolved).toBe(false);
  });

  it("includes requiredVars and labels", async () => {
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: mockStore() });
    const details = await client.getFlagDetails();
    expect(details.find((d) => d.key === "new-dashboard")!.requiredVars).toEqual([
      "NEW_DASHBOARD_API_KEY",
    ]);
    expect(details.find((d) => d.key === "always-on")!.requiredVars).toEqual([]);
    expect(details.find((d) => d.key === "new-dashboard")!.label).toBe("New Dashboard");
  });
});

// ─── Override caches (port of getGlobalOverrides/getTenantOverrides suites) ──

describe("override caches", () => {
  it("getGlobalOverrides caches results and does not re-fetch within TTL", async () => {
    const store = mockStore({
      listGlobalOverrides: vi
        .fn()
        .mockResolvedValue([{ flagKey: "new-dashboard", enabled: false }]),
    });
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: store });
    const first = await client.getGlobalOverrides();
    const second = await client.getGlobalOverrides();
    expect(store.listGlobalOverrides).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.get("new-dashboard")).toBe(false);
  });

  it("re-fetches after the TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const store = mockStore();
      const client = new FeatureFlagClient({
        flags: FLAGS,
        env: FULL_ENV,
        overrides: store,
        cacheTtlMs: 60_000,
      });
      await client.getGlobalOverrides();
      vi.advanceTimersByTime(59_999);
      await client.getGlobalOverrides();
      expect(store.listGlobalOverrides).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2);
      await client.getGlobalOverrides();
      expect(store.listGlobalOverrides).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns empty map when the store throws (error is logged, cached)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = mockStore({
      listGlobalOverrides: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: store });
    const result = await client.getGlobalOverrides();
    expect(result.size).toBe(0);
    expect(consoleSpy).toHaveBeenCalled();
    // failure result is cached (mirrors source behavior)
    await client.getGlobalOverrides();
    expect(store.listGlobalOverrides).toHaveBeenCalledTimes(1);
  });

  it("getTenantOverrides caches per tenantId", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ flagKey: "new-dashboard", enabled: false }])
      .mockResolvedValueOnce([{ flagKey: "beta-export", enabled: false }]);
    const store = mockStore({ listTenantOverrides: list });
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: store });
    const t1First = await client.getTenantOverrides("tenant-1");
    const t1Second = await client.getTenantOverrides("tenant-1");
    const t2 = await client.getTenantOverrides("tenant-2");
    expect(list).toHaveBeenCalledTimes(2);
    expect(t1First).toBe(t1Second);
    expect(t1First.get("new-dashboard")).toBe(false);
    expect(t2.get("beta-export")).toBe(false);
  });
});

// ─── Cache invalidation (port of "cache invalidation" suite) ──────────────────

describe("cache invalidation", () => {
  it("clearGlobalOverridesCache forces re-fetch", async () => {
    const store = mockStore();
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: store });
    await client.getGlobalOverrides();
    expect(store.listGlobalOverrides).toHaveBeenCalledTimes(1);
    client.clearGlobalOverridesCache();
    await client.getGlobalOverrides();
    expect(store.listGlobalOverrides).toHaveBeenCalledTimes(2);
  });

  it("clearTenantOverridesCache forces re-fetch for that tenant only", async () => {
    const store = mockStore();
    const client = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV, overrides: store });
    await client.getTenantOverrides("tenant-1");
    await client.getTenantOverrides("tenant-2");
    expect(store.listTenantOverrides).toHaveBeenCalledTimes(2);
    client.clearTenantOverridesCache("tenant-1");
    await client.getTenantOverrides("tenant-1"); // re-fetched
    await client.getTenantOverrides("tenant-2"); // still cached
    expect(store.listTenantOverrides).toHaveBeenCalledTimes(3);
  });
});

// ─── Tenant elevation (port of feature-flags-byok.test.ts) ───────────────────

describe("tenant elevation", () => {
  const TENANT = "tenant-elevation-test";

  it("elevator can turn ON flags without env vars", async () => {
    const client = new FeatureFlagClient({
      flags: FLAGS,
      env: {},
      elevate: async () => ({ "new-dashboard": true, "beta-export": true }),
    });
    const flags = await client.resolveFlags(TENANT);
    expect(flags["new-dashboard"]).toBe(true);
    expect(flags["beta-export"]).toBe(true);
  });

  it("elevator false values add nothing (only true elevates)", async () => {
    const client = new FeatureFlagClient({
      flags: FLAGS,
      env: {},
      elevate: async () => ({ "new-dashboard": false }),
    });
    const flags = await client.resolveFlags(TENANT);
    expect(flags["new-dashboard"]).toBe(false);
  });

  it("no elevation → infra-based resolution unchanged (regression guard)", async () => {
    const client = new FeatureFlagClient({
      flags: FLAGS,
      env: {},
      elevate: async () => ({}),
    });
    const infra = client.getFlags();
    const resolved = await client.resolveFlags(TENANT);
    expect(resolved["new-dashboard"]).toBe(infra["new-dashboard"]);
    expect(resolved["beta-export"]).toBe(infra["beta-export"]);
  });

  it("second call uses the elevation cache — elevator called only once", async () => {
    const elevate = vi.fn().mockResolvedValue({ "new-dashboard": true });
    const client = new FeatureFlagClient({ flags: FLAGS, env: {}, elevate });
    await client.resolveFlags(TENANT);
    await client.resolveFlags(TENANT);
    expect(elevate).toHaveBeenCalledTimes(1);
  });

  it("clearElevationCache forces the elevator to run again", async () => {
    const elevate = vi.fn().mockResolvedValue({ "new-dashboard": true });
    const client = new FeatureFlagClient({ flags: FLAGS, env: {}, elevate });
    await client.resolveFlags(TENANT);
    client.clearElevationCache(TENANT);
    await client.resolveFlags(TENANT);
    expect(elevate).toHaveBeenCalledTimes(2);
  });

  it("without tenantId, the elevator is never called", async () => {
    const elevate = vi.fn().mockResolvedValue({ "new-dashboard": true });
    const client = new FeatureFlagClient({ flags: FLAGS, env: {}, elevate });
    const flags = await client.resolveFlags();
    expect(elevate).not.toHaveBeenCalled();
    expect(flags["new-dashboard"]).toBe(false);
  });
});

// ─── Override mutations + audit trail ─────────────────────────────────────────

describe("override mutations and audit trail", () => {
  let events: FlagAuditEvent[];
  let store: InMemoryOverrideStore;
  let client: FeatureFlagClient<Key>;

  beforeEach(() => {
    events = [];
    store = new InMemoryOverrideStore();
    client = new FeatureFlagClient({
      flags: FLAGS,
      env: FULL_ENV,
      overrides: store,
      audit: { record: (e) => void events.push(e) },
    });
  });

  it("setGlobalOverride writes, invalidates cache, and records an audit event", async () => {
    expect((await client.resolveFlags())["new-dashboard"]).toBe(true);
    await client.setGlobalOverride("new-dashboard", false, "admin@example.com");
    // cache was cleared → next resolve sees the new override
    expect((await client.resolveFlags())["new-dashboard"]).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        action: "upsert",
        scope: "global",
        flagKey: "new-dashboard",
        enabled: false,
        updatedBy: "admin@example.com",
      }),
    ]);
    expect(events[0]!.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("removeGlobalOverride restores default resolution and records an audit event", async () => {
    await client.setGlobalOverride("new-dashboard", false);
    await client.removeGlobalOverride("new-dashboard");
    expect((await client.resolveFlags())["new-dashboard"]).toBe(true);
    expect(events[1]).toEqual(
      expect.objectContaining({ action: "delete", scope: "global", flagKey: "new-dashboard" }),
    );
  });

  it("setTenantOverride affects only that tenant and records tenantId", async () => {
    await client.setTenantOverride("tenant-1", "beta-export", false, "admin@example.com");
    expect((await client.resolveFlags("tenant-1"))["beta-export"]).toBe(false);
    expect((await client.resolveFlags("tenant-2"))["beta-export"]).toBe(true);
    expect(events[0]).toEqual(
      expect.objectContaining({
        action: "upsert",
        scope: "tenant",
        tenantId: "tenant-1",
        flagKey: "beta-export",
        enabled: false,
      }),
    );
  });

  it("removeTenantOverride invalidates that tenant's cache", async () => {
    await client.setTenantOverride("tenant-1", "beta-export", false);
    expect((await client.resolveFlags("tenant-1"))["beta-export"]).toBe(false);
    await client.removeTenantOverride("tenant-1", "beta-export");
    expect((await client.resolveFlags("tenant-1"))["beta-export"]).toBe(true);
    expect(events[1]).toEqual(
      expect.objectContaining({ action: "delete", scope: "tenant", tenantId: "tenant-1" }),
    );
  });

  it("updatedBy defaults to 'unknown' (mirrors `email || \"unknown\"`)", async () => {
    await client.setGlobalOverride("beta-export", false);
    expect(events[0]!.updatedBy).toBe("unknown");
  });

  it("throws a descriptive error when no store (or write method) is configured", async () => {
    const readOnly = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV });
    await expect(readOnly.setGlobalOverride("beta-export", false)).rejects.toThrow(
      /does not support upsertGlobalOverride/,
    );
  });
});

// ─── featureNotConfigured (port of the 501 helper) ────────────────────────────

describe("featureNotConfigured", () => {
  it("returns a 501 JSON response listing required env vars", async () => {
    const client = new FeatureFlagClient({ flags: FLAGS, env: {} });
    const res = client.featureNotConfigured("new-dashboard");
    expect(res.status).toBe(501);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = (await res.json()) as { error: string; feature: string; message: string };
    expect(body.error).toBe("feature_not_configured");
    expect(body.feature).toBe("new-dashboard");
    expect(body.message).toContain("NEW_DASHBOARD_API_KEY");
  });
});

// ─── Canary (port of isAutonomousAgentEnabled / isDigitalTwinEnabled logic) ──

describe("isCanaryEnabled", () => {
  it("non-empty canary list: only listed tenants get the flag", () => {
    const client = new FeatureFlagClient({
      flags: FLAGS,
      env: { ...FULL_ENV, NEW_DASHBOARD_CANARY_TENANT_IDS: "tenant-a,tenant-b" },
    });
    expect(client.isCanaryEnabled("new-dashboard", "tenant-a", "NEW_DASHBOARD_CANARY_TENANT_IDS")).toBe(true);
    expect(client.isCanaryEnabled("new-dashboard", "tenant-z", "NEW_DASHBOARD_CANARY_TENANT_IDS")).toBe(false);
  });

  it("empty/unset canary list falls back to the infra flag", () => {
    const on = new FeatureFlagClient({ flags: FLAGS, env: FULL_ENV });
    const off = new FeatureFlagClient({ flags: FLAGS, env: {} });
    expect(on.isCanaryEnabled("new-dashboard", "tenant-z", "NEW_DASHBOARD_CANARY_TENANT_IDS")).toBe(true);
    expect(off.isCanaryEnabled("new-dashboard", "tenant-z", "NEW_DASHBOARD_CANARY_TENANT_IDS")).toBe(false);
  });
});
