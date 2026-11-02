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
  type TenantResolverOptions,
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

function makeResolver(
  store: TenantStore,
  sessionEmail: string | null = null,
  extra: Partial<TenantResolverOptions<Request>> = {},
) {
  return createTenantResolver<Request>({
    store,
    adminEmail: "admin@example.com",
    getSessionEmail: async () => sessionEmail,
    logWarn: noopWarn,
    ...extra,
  });
}

const req = new Request("https://example.com/");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AC-40: getOrCreateDefaultTenant（既存・挙動は不変）", () => {
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
  // 2026-11-02 意図した書き換え (SA-0003): 旧「email null → 既定テナント」→ AC-30/AC-31
  it("AC-30: session email が null なら null を返す（既定テナントへ落とさない）", async () => {
    const store = makeStore({
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-tenant-id"),
      findTenantBySlug: vi.fn().mockResolvedValue("default-tenant-id"),
      createTenant: vi.fn().mockResolvedValue("default-tenant-id"),
    });
    const resolver = makeResolver(store, null);
    expect(await resolver.getTenantId(req)).toBeNull();
    expect(store.findMemberByEmail).not.toHaveBeenCalled();
  });

  it("AC-31: session email が null なら findTenantBySlug と createTenant を 0 回しか呼ばない", async () => {
    const store = makeStore({
      createTenant: vi.fn().mockResolvedValue("created-default-tenant"),
    });
    const resolver = makeResolver(store, null);
    await resolver.getTenantId(req);
    expect(store.findTenantBySlug).toHaveBeenCalledTimes(0);
    expect(store.createTenant).toHaveBeenCalledTimes(0);
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

  // 2026-11-02 意図した書き換え (SA-0003): ドメインでのバックフィルは backfillByEmailDomain:true の時だけ → AC-58
  it("AC-58: backfillByEmailDomain:true なら owner_email が外れたときドメインでバックフィルする (#952)", async () => {
    const findTenantByOwnerEmail = vi
      .fn()
      .mockResolvedValueOnce(null) // exact owner_email — not found
      .mockResolvedValue("default-tenant"); // default-tenant path (not reached here)
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue({ tenant_id: null }),
      findTenantByOwnerEmail,
      findTenantByDomain: vi.fn().mockResolvedValue("linkable-by-domain"),
    });
    const resolver = makeResolver(store, "user@acme.co", { backfillByEmailDomain: true });
    expect(await resolver.getTenantId(req)).toBe("linkable-by-domain");
    expect(store.findTenantByDomain).toHaveBeenCalledWith("acme.co");
  });

  // 2026-11-02 意図した書き換え (SA-0003): 旧「既定テナントへ落ちる」→ AC-34
  it("AC-34: member の tenant_id が NULL でバックフィルにも当たらなければ null", async () => {
    const findTenantByOwnerEmail = vi
      .fn()
      .mockResolvedValueOnce(null) // backfill exact match — miss
      .mockResolvedValueOnce("fallback-tenant"); // default tenant by adminEmail
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue({ tenant_id: null }),
      findTenantByOwnerEmail,
    });
    const resolver = makeResolver(store, "user@example.com");
    expect(await resolver.getTenantId(req)).toBeNull();
  });

  // 2026-11-02 意図した書き換え (SA-0003): 旧「既定テナントへ落ちる」→ AC-32
  it("AC-32: member 行が無い未登録の email (stranger@evil.example) は null", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue(null),
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-for-user"),
      findTenantBySlug: vi.fn().mockResolvedValue("default-for-user"),
    });
    const resolver = makeResolver(store, "stranger@evil.example");
    expect(await resolver.getTenantId(req)).toBeNull();
    // 行が存在しない場合は #952 backfill (domain 検索) は走らない
    expect(store.findTenantByDomain).not.toHaveBeenCalled();
  });

  // 2026-11-02 意図した書き換え (SA-0003): 旧「lookup 例外 → 既定テナント」→ AC-33
  it("AC-33: findMemberByEmail が例外を投げたら null", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockRejectedValue(new Error("lookup failed")),
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("fallback-on-error"),
      findTenantBySlug: vi.fn().mockResolvedValue("fallback-on-error"),
    });
    const resolver = makeResolver(store, "user@example.com");
    expect(await resolver.getTenantId(req)).toBeNull();
  });

  it("AC-33: lookup が例外なら adminEmail の本人でも null", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockRejectedValue(new Error("lookup failed")),
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-tenant"),
      findTenantBySlug: vi.fn().mockResolvedValue("default-tenant"),
    });
    const resolver = makeResolver(store, "admin@example.com");
    expect(await resolver.getTenantId(req)).toBeNull();
  });

  it("AC-35: session email が空文字なら null（既定テナントを作らない）", async () => {
    const store = makeStore({
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-tenant-id"),
      findTenantBySlug: vi.fn().mockResolvedValue("default-tenant-id"),
      createTenant: vi.fn().mockResolvedValue("default-tenant-id"),
    });
    const resolver = makeResolver(store, "");
    expect(await resolver.getTenantId(req)).toBeNull();
    expect(store.createTenant).not.toHaveBeenCalled();
  });

  // 監査 V2 #1 (SA-0003) の再現テストを反転: 未ログイン・未登録・lookup 例外が tenant-admin にならない
  it("AC-32: 監査再現 V2#1 の反転 — null / 未登録 / lookup 例外のどれも 'tenant-admin' にならない", async () => {
    const adminStore = (over: Partial<TenantStore> = {}): TenantStore => ({
      findMemberByEmail: async (e: string) => (e === "alice@acme.com" ? { tenant_id: "tenant-acme" } : null),
      findTenantByOwnerEmail: async () => null,
      findTenantBySlug: async (s: string) => (s === "admin" ? "tenant-admin" : null),
      findTenantByDomain: async () => null,
      createTenant: async () => "tenant-admin",
      ...over,
    });
    const r1 = createTenantResolver<string | null>({
      store: adminStore(),
      getSessionEmail: (e) => e,
      logWarn: noopWarn,
    });
    expect(await r1.getTenantId(null)).toBeNull();
    expect(await r1.getTenantId("stranger@evil.example")).toBeNull();
    expect(await r1.getTenantId("alice@acme.com")).toBe("tenant-acme"); // 登録済みは従来どおり
    const r2 = createTenantResolver<string | null>({
      store: adminStore({
        findMemberByEmail: async () => {
          throw new Error("db down");
        },
      }),
      getSessionEmail: (e) => e,
      logWarn: noopWarn,
    });
    expect(await r2.getTenantId("alice@acme.com")).toBeNull();
  });
});

describe("getTenantId — これまでの正しい動き (G9)", () => {
  it('AC-36: email が "admin" なら既定テナントの ID', async () => {
    const store = makeStore({
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-tenant-id"),
    });
    const resolver = makeResolver(store, "admin");
    expect(await resolver.getTenantId(req)).toBe("default-tenant-id");
  });

  it("AC-37: adminEmail の本人で member 行が無ければ既定テナントの ID", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue(null),
      findTenantByOwnerEmail: vi
        .fn()
        .mockImplementation(async (e: string) => (e === "owner@example.com" ? "owner-default-tenant" : null)),
    });
    const resolver = makeResolver(store, "owner@example.com", { adminEmail: "owner@example.com" });
    expect(await resolver.getTenantId(req)).toBe("owner-default-tenant");
  });

  it("AC-38: member.tenant_id='tenant-x' なら 'tenant-x'", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue({ tenant_id: "tenant-x" }),
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-tenant-id"),
    });
    const resolver = makeResolver(store, "user@example.com");
    expect(await resolver.getTenantId(req)).toBe("tenant-x");
  });

  it("AC-39: tenant_id が NULL で owner_email の完全一致バックフィルが当たればそのテナント", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue({ tenant_id: null }),
      findTenantByOwnerEmail: vi
        .fn()
        .mockImplementation(async (e: string) => (e === "user@acme.co" ? "owned-tenant" : null)),
    });
    const resolver = makeResolver(store, "user@acme.co");
    expect(await resolver.getTenantId(req)).toBe("owned-tenant");
  });

  it("AC-57: 既定設定ではドメイン一致でバックフィルしない（null・findTenantByDomain 0 回）", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue({ tenant_id: null }),
      findTenantByOwnerEmail: vi.fn().mockResolvedValue(null),
      findTenantByDomain: vi.fn().mockResolvedValue("victim-tenant-by-domain"),
    });
    const resolver = makeResolver(store, "attacker@gmail.com");
    expect(await resolver.getTenantId(req)).toBeNull();
    expect(store.findTenantByDomain).toHaveBeenCalledTimes(0);
  });
});

describe("getTenantId — 旧動作は明示したときだけ (G12)", () => {
  it("AC-50: fallbackUnmappedToDefaultTenant:true なら未登録の email は既定テナントの ID", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue(null),
      findTenantByOwnerEmail: vi
        .fn()
        .mockImplementation(async (e: string) => (e === "admin@example.com" ? "default-tenant-id" : null)),
    });
    const resolver = makeResolver(store, "stranger@evil.example", { fallbackUnmappedToDefaultTenant: true });
    expect(await resolver.getTenantId(req)).toBe("default-tenant-id");
  });

  it("AC-51: fallbackUnmappedToDefaultTenant:true でも email が null なら null", async () => {
    const store = makeStore({
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-tenant-id"),
      findTenantBySlug: vi.fn().mockResolvedValue("default-tenant-id"),
      createTenant: vi.fn().mockResolvedValue("default-tenant-id"),
    });
    const resolver = makeResolver(store, null, { fallbackUnmappedToDefaultTenant: true });
    expect(await resolver.getTenantId(req)).toBeNull();
  });

  it("AC-51: fallbackUnmappedToDefaultTenant:true でも lookup が例外なら null", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockRejectedValue(new Error("db down")),
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-tenant-id"),
      findTenantBySlug: vi.fn().mockResolvedValue("default-tenant-id"),
    });
    const resolver = makeResolver(store, "user@example.com", { fallbackUnmappedToDefaultTenant: true });
    expect(await resolver.getTenantId(req)).toBeNull();
  });

  it("AC-52: オプションを省略すると未登録の email は null", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue(null),
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-tenant-id"),
      findTenantBySlug: vi.fn().mockResolvedValue("default-tenant-id"),
    });
    const resolver = makeResolver(store, "stranger@evil.example");
    expect(await resolver.getTenantId(req)).toBeNull();
  });

  it("AC-52: オプションを undefined にしても未登録の email は null", async () => {
    const store = makeStore({
      findMemberByEmail: vi.fn().mockResolvedValue(null),
      findTenantByOwnerEmail: vi.fn().mockResolvedValue("default-tenant-id"),
      findTenantBySlug: vi.fn().mockResolvedValue("default-tenant-id"),
    });
    const resolver = makeResolver(store, "stranger@evil.example", {
      fallbackUnmappedToDefaultTenant: undefined,
      backfillByEmailDomain: undefined,
    });
    expect(await resolver.getTenantId(req)).toBeNull();
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
