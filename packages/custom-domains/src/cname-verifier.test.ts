/**
 * Ported from dev-dashboard-v2 `tests/white-label/cname-verifier.test.ts`
 * (#1340). Supabase/feature-flag mocks replaced by the injected memory store
 * and the `enabled` callback.
 */
import { describe, it, expect, vi } from "vitest";

import { runCnameVerificationCron, verifyCname } from "./cname-verifier";
import { createMemoryDomainStore } from "./memory-store";
import type { DomainRecord } from "./types";

const TARGET = "edge.example-saas.com";

describe("verifyCname", () => {
  it("returns ok when CNAME matches expected target", async () => {
    const resolver = vi.fn().mockResolvedValue([TARGET]);
    const r = await verifyCname("brand.example.com", TARGET, { resolver });
    expect(r.ok).toBe(true);
    expect(r.resolved).toBe(TARGET);
  });

  it("normalizes trailing dot and case", async () => {
    const resolver = vi.fn().mockResolvedValue(["EDGE.EXAMPLE-SAAS.COM."]);
    const r = await verifyCname("brand.example.com", TARGET, { resolver });
    expect(r.ok).toBe(true);
  });

  it("returns ok=false when CNAME does not match", async () => {
    const resolver = vi.fn().mockResolvedValue(["wrong.example.com"]);
    const r = await verifyCname("brand.example.com", TARGET, { resolver });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("cname_mismatch");
  });

  it("returns ok=false on NXDOMAIN", async () => {
    const resolver = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    const r = await verifyCname("missing.example.com", TARGET, { resolver });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("nxdomain");
  });

  it("returns ok=false when no records returned", async () => {
    const resolver = vi.fn().mockResolvedValue([]);
    const r = await verifyCname("empty.example.com", TARGET, { resolver });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_cname_record");
  });

  it("wraps unexpected resolver failures as dns_error", async () => {
    const resolver = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const r = await verifyCname("flaky.example.com", TARGET, { resolver });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("dns_error");
  });
});

describe("runCnameVerificationCron", () => {
  const pendingRow = (over: Partial<DomainRecord> = {}): DomainRecord => ({
    id: "row-1",
    tenantId: "t-1",
    domain: "brand.example.com",
    state: "pending",
    cnameTarget: TARGET,
    ...over,
  });

  it("skips when the kill switch is OFF", async () => {
    const store = createMemoryDomainStore([pendingRow()]);
    const result = await runCnameVerificationCron({
      store,
      target: TARGET,
      enabled: () => false,
    });
    expect(result.processed).toBe(0);
    expect(store.get("row-1")?.state).toBe("pending");
  });

  it("transitions matching domain to verified", async () => {
    const store = createMemoryDomainStore([pendingRow()]);
    const resolver = vi.fn().mockResolvedValue([TARGET]);
    const result = await runCnameVerificationCron({ store, target: TARGET, resolver });
    expect(result.processed).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.failed).toBe(0);
    const row = store.get("row-1");
    expect(row?.state).toBe("verified");
    expect(row?.error).toBeNull();
    expect(row?.verifiedAt).toBeTruthy();
  });

  it("marks misconfigured domain as failed", async () => {
    const store = createMemoryDomainStore([
      pendingRow({ id: "row-2", domain: "bad.example.com" }),
    ]);
    const resolver = vi.fn().mockResolvedValue(["wrong.example.com"]);
    const result = await runCnameVerificationCron({ store, target: TARGET, resolver });
    expect(result.failed).toBe(1);
    const row = store.get("row-2");
    expect(row?.state).toBe("failed");
    expect(row?.error).toContain("cname_mismatch");
  });

  it("falls back to the cron-level target when the row has none", async () => {
    const store = createMemoryDomainStore([pendingRow({ cnameTarget: null })]);
    const resolver = vi.fn().mockResolvedValue([TARGET]);
    const result = await runCnameVerificationCron({ store, target: TARGET, resolver });
    expect(result.verified).toBe(1);
  });

  it("returns an empty summary when the store read fails", async () => {
    const store = createMemoryDomainStore();
    store.listByState = vi.fn().mockRejectedValue(new Error("db down"));
    const result = await runCnameVerificationCron({ store, target: TARGET });
    expect(result).toEqual({ processed: 0, verified: 0, failed: 0, results: [] });
  });
});
