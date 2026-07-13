/**
 * Guard tests ported from the "Consent Guard" section of
 * 実運用SaaS `tests/integration/consent-wiring.test.ts`,
 * plus grant/revoke and revocation-cascade coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createConsentGuard,
  InMemoryConsentStore,
  ConsentMissingError,
  EXAMPLE_COS_REVOCATION_CASCADE,
  type ExampleConsentPurpose,
} from "./index";

const mockTenantId = "tenant-123";
const mockUserUuid = "uuid-789";

let store: InMemoryConsentStore;

beforeEach(() => {
  store = new InMemoryConsentStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeGuard(extra: Partial<Parameters<typeof createConsentGuard>[0]> = {}) {
  return createConsentGuard<ExampleConsentPurpose>({
    store,
    log: () => {},
    ...extra,
  });
}

describe("Consent Guard", () => {
  it("hasConsent returns true if record exists and is not revoked", async () => {
    const hasActiveSpy = vi.spyOn(store, "hasActiveConsent");
    await store.grant({
      tenantId: mockTenantId,
      userId: mockUserUuid,
      purpose: "ai_learning",
      basis: "explicit_consent",
      grantedAt: new Date().toISOString(),
    });

    const guard = makeGuard();
    const result = await guard.hasConsent(mockUserUuid, mockTenantId, "ai_learning");
    expect(result).toBe(true);
    expect(hasActiveSpy).toHaveBeenCalled();
  });

  it("hasConsent returns false for a revoked record", async () => {
    await store.grant({
      tenantId: mockTenantId,
      userId: mockUserUuid,
      purpose: "ai_learning",
      basis: "explicit_consent",
      grantedAt: new Date().toISOString(),
    });
    await store.revoke(mockTenantId, mockUserUuid, "ai_learning", new Date().toISOString());

    const guard = makeGuard();
    expect(await guard.hasConsent(mockUserUuid, mockTenantId, "ai_learning")).toBe(false);
  });

  it("hasConsent uses cache on subsequent calls", async () => {
    const hasActiveSpy = vi.spyOn(store, "hasActiveConsent").mockResolvedValue(true);
    const guard = makeGuard();

    await guard.hasConsent(mockUserUuid, mockTenantId, "ai_learning");
    const result = await guard.hasConsent(mockUserUuid, mockTenantId, "ai_learning");

    expect(result).toBe(true);
    expect(hasActiveSpy).toHaveBeenCalledTimes(1); // Only once
  });

  it("cache expires after the TTL (60s source default)", async () => {
    vi.useFakeTimers();
    const hasActiveSpy = vi.spyOn(store, "hasActiveConsent").mockResolvedValue(true);
    const guard = makeGuard();

    await guard.hasConsent(mockUserUuid, mockTenantId, "ai_learning");
    vi.advanceTimersByTime(59_000);
    await guard.hasConsent(mockUserUuid, mockTenantId, "ai_learning");
    expect(hasActiveSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000); // past 60s
    await guard.hasConsent(mockUserUuid, mockTenantId, "ai_learning");
    expect(hasActiveSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("invalidateConsentCache forces a fresh store lookup", async () => {
    const hasActiveSpy = vi.spyOn(store, "hasActiveConsent").mockResolvedValue(false);
    const guard = makeGuard();

    await guard.hasConsent(mockUserUuid, mockTenantId, "ai_learning");
    guard.invalidateConsentCache(mockUserUuid, mockTenantId, "ai_learning");
    await guard.hasConsent(mockUserUuid, mockTenantId, "ai_learning");
    expect(hasActiveSpy).toHaveBeenCalledTimes(2);
  });

  it("requireConsent throws if no consent", async () => {
    const guard = makeGuard();
    await expect(guard.requireConsent(mockUserUuid, mockTenantId, "ai_learning")).rejects.toThrow(
      "Consent required for purpose: ai_learning",
    );
    await expect(
      guard.requireConsent(mockUserUuid, mockTenantId, "ai_learning"),
    ).rejects.toBeInstanceOf(ConsentMissingError);
  });

  it("requireConsent resolves when consent is granted", async () => {
    const guard = makeGuard();
    await guard.grantConsent(mockTenantId, mockUserUuid, "ai_learning", "explicit_consent");
    await expect(
      guard.requireConsent(mockUserUuid, mockTenantId, "ai_learning"),
    ).resolves.toBeUndefined();
  });

  it("hasConsent returns false when the store rejects (fail-closed)", async () => {
    const onError = vi.fn();
    vi.spyOn(store, "hasActiveConsent").mockRejectedValue(new Error("db down"));
    const guard = makeGuard({ onError });

    const result = await guard.hasConsent(mockUserUuid, mockTenantId, "email_digest");
    expect(result).toBe(false);
    expect(onError).toHaveBeenCalled();
  });
});

describe("grant / revoke operations", () => {
  it("grantConsent stores the record with legal basis and invalidates the cache", async () => {
    const guard = makeGuard();
    // Prime the cache with "not granted"
    expect(await guard.hasConsent(mockUserUuid, mockTenantId, "slack_ingestion")).toBe(false);

    const res = await guard.grantConsent(
      mockTenantId,
      mockUserUuid,
      "slack_ingestion",
      "explicit_consent",
    );
    expect(res.ok).toBe(true);
    expect(store.records[0]).toMatchObject({
      tenantId: mockTenantId,
      userId: mockUserUuid,
      purpose: "slack_ingestion",
      basis: "explicit_consent",
    });
    // Cache was invalidated → fresh lookup sees the grant
    expect(await guard.hasConsent(mockUserUuid, mockTenantId, "slack_ingestion")).toBe(true);
  });

  it("revokeConsent sets revoked_at and invalidates the cache", async () => {
    const guard = makeGuard();
    await guard.grantConsent(mockTenantId, mockUserUuid, "ai_learning", "contract");
    expect(await guard.hasConsent(mockUserUuid, mockTenantId, "ai_learning")).toBe(true);

    const res = await guard.revokeConsent(mockTenantId, mockUserUuid, "ai_learning");
    expect(res.ok).toBe(true);
    expect(store.records[0]!.revokedAt).toEqual(expect.any(String));
    expect(await guard.hasConsent(mockUserUuid, mockTenantId, "ai_learning")).toBe(false);
  });
});

describe("revocation cascade", () => {
  function seedCosTables() {
    store.seed("cos_digest_items", [
      { id: "d1", tenant_id: mockTenantId, source_type: "slack" },
      { id: "d2", tenant_id: mockTenantId, source_type: "email" },
      { id: "d3", tenant_id: "other-tenant", source_type: "slack" },
    ]);
    store.seed("cos_extracted_tasks", [{ id: "t1", tenant_id: mockTenantId }]);
    store.seed("cos_briefings", [{ id: "b1", tenant_id: mockTenantId }]);
  }

  it("returns [] for purposes without a cascade mapping", async () => {
    const guard = makeGuard({ revocationCascade: EXAMPLE_COS_REVOCATION_CASCADE });
    const results = await guard.onConsentRevoked(mockTenantId, "ai_learning");
    expect(results).toEqual([]);
  });

  it("umbrella revoke purges every mapped table for the tenant only", async () => {
    seedCosTables();
    const guard = makeGuard({ revocationCascade: EXAMPLE_COS_REVOCATION_CASCADE });

    const results = await guard.onConsentRevoked(mockTenantId, "external_data_processing");
    expect(results.map((r) => r.table)).toEqual([
      "cos_extracted_tasks",
      "cos_digest_items",
      "cos_briefings",
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(store.tables.get("cos_extracted_tasks")).toEqual([]);
    expect(store.tables.get("cos_briefings")).toEqual([]);
    // Other tenants' rows survive
    expect(store.tables.get("cos_digest_items")).toEqual([
      { id: "d3", tenant_id: "other-tenant", source_type: "slack" },
    ]);
  });

  it("per-source revoke purges only rows matching the source_type filter", async () => {
    seedCosTables();
    const guard = makeGuard({ revocationCascade: EXAMPLE_COS_REVOCATION_CASCADE });

    await guard.onConsentRevoked(mockTenantId, "slack_content_analysis");
    expect(store.tables.get("cos_digest_items")).toEqual([
      { id: "d2", tenant_id: mockTenantId, source_type: "email" },
      { id: "d3", tenant_id: "other-tenant", source_type: "slack" },
    ]);
  });

  it("supports a fully custom cascade callback", async () => {
    const callback = vi.fn().mockResolvedValue([{ table: "custom", ok: true }]);
    const guard = makeGuard({ revocationCascade: callback });

    const results = await guard.onConsentRevoked(mockTenantId, "email_content_analysis");
    expect(callback).toHaveBeenCalledWith(mockTenantId, "email_content_analysis");
    expect(results).toEqual([{ table: "custom", ok: true }]);
  });

  it("revokeConsent triggers the cascade and reports results", async () => {
    seedCosTables();
    const guard = makeGuard({ revocationCascade: EXAMPLE_COS_REVOCATION_CASCADE });
    await guard.grantConsent(mockTenantId, mockUserUuid, "external_data_processing", "explicit_consent");

    const res = await guard.revokeConsent(mockTenantId, mockUserUuid, "external_data_processing");
    expect(res.ok).toBe(true);
    expect(res.cascade).toHaveLength(3);
    expect(store.tables.get("cos_briefings")).toEqual([]);
  });

  it("a single table failure does not block other deletions", async () => {
    seedCosTables();
    vi.spyOn(store, "deleteRows").mockImplementation(async (table) =>
      table === "cos_digest_items" ? { ok: false, error: "boom" } : { ok: true },
    );
    const guard = makeGuard({ revocationCascade: EXAMPLE_COS_REVOCATION_CASCADE });

    const results = await guard.onConsentRevoked(mockTenantId, "external_data_processing");
    expect(results).toHaveLength(3);
    expect(results.find((r) => r.table === "cos_digest_items")).toEqual({
      table: "cos_digest_items",
      ok: false,
      detail: "boom",
    });
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  it("emits a structured log line on propagation (source behavior)", async () => {
    seedCosTables();
    const log = vi.fn();
    const guard = makeGuard({ revocationCascade: EXAMPLE_COS_REVOCATION_CASCADE, log });

    await guard.onConsentRevoked(mockTenantId, "slack_content_analysis");
    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(log.mock.calls[0]![0]);
    expect(parsed).toMatchObject({
      severity: "INFO",
      message: "consent_revoke_propagated",
      tenant_id: mockTenantId,
      purpose: "slack_content_analysis",
    });
  });
});
