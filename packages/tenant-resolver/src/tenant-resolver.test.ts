/**
 * Tests for tenant-resolver.
 * 移植元: 実運用SaaS tests/tenant.test.ts (fetch モック → TenantStore モックに置換)。
 * #952 backfill (member 行はあるが tenant_id NULL → owner/domain で復元) のテストを追加。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createTenantResolver,
  requireTenant,
  requireUser,
  type TenantStore,
} from "./tenant-resolver";

function makeStore(overrides: Partial<TenantStore> = {}): TenantStore {
  return {
    findMemberByEmail: vi.fn().mockResolvedValue(null),
    findTenantByOwnerEmail: vi.fn().mockResolvedValue(null),
    findTenantBySlug: vi.fn().mockResolvedValue(null),
    findTenantByDomain: vi.fn().mockResolvedValue(null),
    createTenant: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const noopWarn = () => {};

function makeResolver(store: TenantStore, sessionEmail: string | null = null) {
  return createTenantResolver<Request>({
    store,
    adminEmail: "admin@example.com",
    getSessionEmail: async () => sessionEmail,
    logWarn: noopWarn,
  });
}

const req = new Request("https://example.com/");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOrCreateDefaultTenant", () => {
  it("returns existing tenant id when found by owner_email", async () => {
    const store = makeStore({
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("tenant-uuid-existing"),
    });
    const resolver = makeResolver(store);
    expect(await resolver.getOrCreateDefaultTenant()).toBe("tenant-uuid-existing");
    expect(store.findTenantByOwnerEmail).toHaveBeenCalledWith("admin@example.com");
  });

  it("creates new tenant when none exists and returns its id", async () => {
    const store = makeStore({
      createTenant: vi.fn().mockResolvedValue("tenant-uuid-new"),
    });
    const resolver = makeResolver(store);
    expect(await resolver.getOrCreateDefaultTenant()).toBe("tenant-uuid-new");
    // slug は adminEmail の local part から導出される
    expect(store.createTenant).toHaveBeenCalledWith({
      name: "admin",
      slug: "admin",
      owner_email: "admin@example.com",
      plan: "free",
      is_active: true,
    });
  });

  it("returns null when creation fails and slug retry is also empty", async () => {
    const store = makeStore();
    const resolver = makeResolver(store);
    expect(await resolver.getOrCreateDefaultTenant()).toBeNull();
    // owner → slug → create → slug retry の順で全パス試行
    expect(store.findTenantBySlug).toHaveBeenCalledTimes(2);
  });

  it("returns null on store error across all paths", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockRejectedValue(new Error("network error")),
      findTenantByOwnerEmail: vi.fn().mockRejectedValue(new Error("network error")),
      findTenantBySlug: vi.fn().mockRejectedValue(new Error("network error")),
      findTenantByDomain: vi.fn().mockRejectedValue(new Error("network error")),
      createTenant: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const resolver = makeResolver(store);
    expect(await resolver.getOrCreateDefaultTenant()).toBeNull();
  });

  it("falls back to slug=admin lookup when owner_email lookup throws", async () => {
    const store = makeStore({
      findTenantByOwnerEmail: vi.fn().mockRejectedValue(new Error("boom")),
      findTenantBySlug: vi.fn().mockResolvedValue("slug-tenant-id"),
    });
    const resolver = makeResolver(store);
    expect(await resolver.getOrCreateDefaultTenant()).toBe("slug-tenant-id");
    expect(store.findTenantBySlug).toHaveBeenCalledWith("admin");
  });

  it("caches the resolved tenant id (subsequent calls do not hit the store)", async () => {
    const findTenantByOwnerEmail = vi.fn().mockResolvedValue("cached-id");
    const store = makeStore({ findTenantByOwnerEmail });
    const resolver = makeResolver(store);
    expect(await resolver.getOrCreateDefaultTenant()).toBe("cached-id");
    const callsAfterFirst = findTenantByOwnerEmail.mock.calls.length;
    expect(await resolver.getOrCreateDefaultTenant()).toBe("cached-id");
    expect(findTenantByOwnerEmail.mock.calls.length).toBe(callsAfterFirst); // no new calls
  });

  it("resetDefaultTenantCache clears the cache", async () => {
    const findTenantByOwnerEmail = vi.fn().mockResolvedValue("cached-id");
    const store = makeStore({ findTenantByOwnerEmail });
    const resolver = makeResolver(store);
    await resolver.getOrCreateDefaultTenant();
    resolver.resetDefaultTenantCache();
    await resolver.getOrCreateDefaultTenant();
    expect(findTenantByOwnerEmail).toHaveBeenCalledTimes(2);
  });

  it("skips owner_email lookup and uses slug when adminEmail is empty", async () => {
    const store = makeStore({
      findTenantBySlug: vi.fn().mockResolvedValue("slug-only-id"),
    });
    const resolver = createTenantResolver({
      store,
      getSessionEmail: async () => null,
      logWarn: noopWarn,
    });
    expect(await resolver.getOrCreateDefaultTenant()).toBe("slug-only-id");
    expect(store.findTenantByOwnerEmail).not.toHaveBeenCalled();
  });
});

describe("getTenantId", () => {
  it("delegates to getOrCreateDefaultTenant when session email is null", async () => {
    const store = makeStore({
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-tenant-id"),
    });
    const resolver = makeResolver(store, null);
    expect(await resolver.getTenantId(req)).toBe("default-tenant-id");
    expect(store.findMemberByEmail).not.toHaveBeenCalled();
  });

  it('delegates to getOrCreateDefaultTenant when email is "admin"', async () => {
    const store = makeStore({
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("admin-tenant-id"),
    });
    const resolver = makeResolver(store, "admin");
    expect(await resolver.getTenantId(req)).toBe("admin-tenant-id");
    expect(store.findMemberByEmail).not.toHaveBeenCalled();
  });

  it("returns tenant_id from the member row for a regular user", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue({ tenant_id: "user-tenant-id" }),
    });
    const resolver = makeResolver(store, "user@example.com");
    expect(await resolver.getTenantId(req)).toBe("user-tenant-id");
    expect(store.findMemberByEmail).toHaveBeenCalledWith("user@example.com");
  });

  it("backfills via owner_email when member row exists with NULL tenant_id (#952)", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue({ tenant_id: null }),
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("linkable-by-owner"),
    });
    const resolver = makeResolver(store, "user@acme.co");
    expect(await resolver.getTenantId(req)).toBe("linkable-by-owner");
    expect(store.findTenantByOwnerEmail).toHaveBeenCalledWith("user@acme.co");
  });

  it("backfills via email domain when owner_email misses (#952)", async () => {
    const findTenantByOwnerEmail = vi
      .fn()
      .mockResolvedValueOnce(null) // exact owner_email — not found
      .mockResolvedValue("default-tenant"); // default-tenant path (not reached here)
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue({ tenant_id: null }),
      findTenantByOwnerEmail,
      findTenantByDomain: vi.fn().mockResolvedValue("linkable-by-domain"),
    });
    const resolver = makeResolver(store, "user@acme.co");
    expect(await resolver.getTenantId(req)).toBe("linkable-by-domain");
    expect(store.findTenantByDomain).toHaveBeenCalledWith("acme.co");
  });

  it("falls back to default tenant when member row has NULL tenant_id and no backfill match", async () => {
    const findTenantByOwnerEmail = vi
      .fn()
      .mockResolvedValueOnce(null) // backfill exact match — miss
      .mockResolvedValueOnce("fallback-tenant"); // default tenant by adminEmail
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue({ tenant_id: null }),
      findTenantByOwnerEmail,
    });
    const resolver = makeResolver(store, "user@example.com");
    expect(await resolver.getTenantId(req)).toBe("fallback-tenant");
  });

  it("falls back to default tenant when member lookup returns no row (no domain backfill)", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue(null),
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-for-user"),
    });
    const resolver = makeResolver(store, "user@example.com");
    expect(await resolver.getTenantId(req)).toBe("default-for-user");
    // 行が存在しない場合は #952 backfill (domain 検索) は走らない
    expect(store.findTenantByDomain).not.toHaveBeenCalled();
  });

  it("falls back on store error during member lookup", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockRejectedValue(new Error("lookup failed")),
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("fallback-on-error"),
    });
    const resolver = makeResolver(store, "user@example.com");
    expect(await resolver.getTenantId(req)).toBe("fallback-on-error");
  });
});

describe("request guards", () => {
  it("requireTenant returns pre-populated tenantId", () => {
    expect(requireTenant({ tenantId: "t-1" })).toBe("t-1");
  });

  it("requireTenant throws when missing", () => {
    expect(() => requireTenant({})).toThrow("Tenant not resolved");
  });

  it("requireUser returns pre-populated userId", () => {
    expect(requireUser({ userId: "u-1" })).toBe("u-1");
  });

  it("requireUser throws when missing", () => {
    expect(() => requireUser({})).toThrow("User not authenticated");
  });
});
