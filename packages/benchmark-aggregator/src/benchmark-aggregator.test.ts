/**
 * Ported from 実運用SaaS `tests/industry-benchmark.test.ts` (lib-level
 * scenarios; HTTP route tests stay in the app) — adapted from supabase mocks
 * to InMemoryBenchmarkStore. Anonymizer tests folded in from
 * `server/lib/benchmark/anonymizer.ts` usage.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { BENCHMARK_K_ANON_MIN } from "./types";
import {
  percentile,
  aggregateIndustryKPIs,
  BenchmarkService,
  InMemoryBenchmarkStore,
} from "./benchmark-aggregator";
import {
  MIN_K_ANONYMITY,
  hashTenantId,
  anonymizeTenantRows,
  applyKAnonymity,
} from "./anonymizer";

const NOW = new Date("2026-06-01T00:00:00.000Z");

let store: InMemoryBenchmarkStore;
let service: BenchmarkService;

beforeEach(() => {
  store = new InMemoryBenchmarkStore();
  service = new BenchmarkService({ store, now: () => NOW });
});

// ─── Pure aggregation logic ──────────────────────────────────────────────────

describe("percentile", () => {
  it("returns null on empty array", () => {
    expect(percentile([], 50)).toBeNull();
  });
  it("returns the only value when length=1", () => {
    expect(percentile([42], 50)).toBe(42);
  });
  it("matches NumPy linear method on a known sample", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBeCloseTo(5.5);
    expect(percentile(xs, 25)).toBeCloseTo(3.25);
    expect(percentile(xs, 75)).toBeCloseTo(7.75);
  });
  it("throws on out-of-range p", () => {
    expect(() => percentile([1, 2, 3], -1)).toThrow();
    expect(() => percentile([1, 2, 3], 101)).toThrow();
  });
});

describe("aggregateIndustryKPIs (k-anonymization)", () => {
  it("returns null when sample_size < BENCHMARK_K_ANON_MIN (suppression)", () => {
    const samples = Array.from({ length: BENCHMARK_K_ANON_MIN - 1 }, (_, i) => i + 1);
    expect(aggregateIndustryKPIs("saas", "open_rate", "2026-Q2", samples)).toBeNull();
  });
  it("returns null when sample is empty", () => {
    expect(aggregateIndustryKPIs("saas", "open_rate", "2026-Q2", [])).toBeNull();
  });
  it("returns percentiles when sample_size === BENCHMARK_K_ANON_MIN", () => {
    const samples = Array.from({ length: BENCHMARK_K_ANON_MIN }, (_, i) => i + 1);
    const result = aggregateIndustryKPIs("saas", "open_rate", "2026-Q2", samples);
    expect(result).not.toBeNull();
    expect(result!.sample_size).toBe(BENCHMARK_K_ANON_MIN);
    expect(result!.percentile_50).toBeCloseTo(5.5);
    expect(result!.industry).toBe("saas");
    expect(result!.kpi_name).toBe("open_rate");
    expect(result!.period).toBe("2026-Q2");
  });
  it("returns percentiles when sample_size > BENCHMARK_K_ANON_MIN", () => {
    const samples = Array.from({ length: 50 }, (_, i) => i + 1);
    const result = aggregateIndustryKPIs("ecommerce", "cpa", "rolling-30d", samples);
    expect(result!.sample_size).toBe(50);
    expect(result!.percentile_25).toBeCloseTo(13.25);
    expect(result!.percentile_50).toBeCloseTo(25.5);
    expect(result!.percentile_75).toBeCloseTo(37.75);
    expect(result!.percentile_5).toBeCloseTo(3.45);
    expect(result!.percentile_95).toBeCloseTo(47.55);
  });
  it("stamps computed_at from the injected clock", () => {
    const samples = Array.from({ length: BENCHMARK_K_ANON_MIN }, (_, i) => i + 1);
    const result = service.aggregate("saas", "open_rate", "2026-Q2", samples);
    expect(result!.computed_at).toBe(NOW.toISOString());
  });
});

// ─── Opt-in filter ───────────────────────────────────────────────────────────

describe("listOptedInTenantIds (opt-in filter)", () => {
  beforeEach(() => {
    store.consents.push(
      { tenant_id: "t-none", share_level: "none", opted_in_at: null, opted_out_at: "2026-01-01", updated_at: "2026-01-01" },
      { tenant_id: "t-kpi", share_level: "kpi_only", opted_in_at: "2026-01-01", opted_out_at: null, updated_at: "2026-01-01" },
      { tenant_id: "t-pat", share_level: "patterns", opted_in_at: "2026-01-01", opted_out_at: null, updated_at: "2026-01-01" },
      { tenant_id: "t-full", share_level: "full", opted_in_at: "2026-01-01", opted_out_at: null, updated_at: "2026-01-01" },
    );
  });

  it("excludes tenants with share_level='none'", async () => {
    const ids = await service.listOptedInTenantIds("kpi_only");
    expect(ids).toEqual(["t-kpi", "t-pat", "t-full"]);
    expect(ids).not.toContain("t-none");
  });

  it("for min='full' only includes 'full'", async () => {
    const ids = await service.listOptedInTenantIds("full");
    expect(ids).toEqual(["t-full"]);
  });

  it("for min='patterns' includes patterns and full", async () => {
    const ids = await service.listOptedInTenantIds("patterns");
    expect(ids).toEqual(["t-pat", "t-full"]);
  });
});

// ─── Consent registry ────────────────────────────────────────────────────────

describe("getTenantConsent", () => {
  it("returns synthetic 'none' row when tenant has no record", async () => {
    const row = await service.getTenantConsent("tenant-x");
    expect(row.tenant_id).toBe("tenant-x");
    expect(row.share_level).toBe("none");
    expect(row.opted_in_at).toBeNull();
  });
  it("returns the row when present", async () => {
    store.consents.push({
      tenant_id: "tenant-y",
      share_level: "kpi_only",
      opted_in_at: "2026-05-01T00:00:00.000Z",
      opted_out_at: null,
      updated_at: "2026-05-01T00:00:00.000Z",
    });
    const row = await service.getTenantConsent("tenant-y");
    expect(row.share_level).toBe("kpi_only");
  });
});

describe("setTenantConsent", () => {
  it("inserts a new row when tenant has no record (opt-in)", async () => {
    const updated = await service.setTenantConsent("tenant-z", "kpi_only");
    expect(updated.share_level).toBe("kpi_only");
    expect(updated.opted_in_at).toBe(NOW.toISOString());
    expect(store.consents).toHaveLength(1);
    expect(store.consents[0]!.tenant_id).toBe("tenant-z");
  });

  it("records opted_out_at when first write is 'none'", async () => {
    const updated = await service.setTenantConsent("tenant-o", "none");
    expect(updated.opted_out_at).toBe(NOW.toISOString());
    expect(updated.opted_in_at).toBeNull();
  });

  it("patches an existing row (opt-out) and keeps original opted_in_at on re-opt-in", async () => {
    store.consents.push({
      tenant_id: "tenant-w",
      share_level: "kpi_only",
      opted_in_at: "2026-04-01T00:00:00.000Z",
      opted_out_at: null,
      updated_at: "2026-04-01T00:00:00.000Z",
    });

    const optedOut = await service.setTenantConsent("tenant-w", "none");
    expect(optedOut.share_level).toBe("none");
    expect(optedOut.opted_out_at).toBe(NOW.toISOString());

    const reOptIn = await service.setTenantConsent("tenant-w", "patterns");
    expect(reOptIn.share_level).toBe("patterns");
    // opted_in_at preserved from the first opt-in
    expect(reOptIn.opted_in_at).toBe("2026-04-01T00:00:00.000Z");
  });
});

// ─── Read-path ───────────────────────────────────────────────────────────────

describe("getIndustryBenchmark", () => {
  it("returns the latest snapshot for industry/kpi/period", async () => {
    store.benchmarks.push(
      {
        id: "row-old", industry: "saas", kpi_name: "open_rate", period: "2026-Q2",
        percentile_5: null, percentile_25: 0.1, percentile_50: 0.15, percentile_75: 0.2, percentile_95: null,
        sample_size: 12, computed_at: "2026-04-01T00:00:00.000Z",
      },
      {
        id: "row-1", industry: "saas", kpi_name: "open_rate", period: "2026-Q2",
        percentile_5: null, percentile_25: 0.15, percentile_50: 0.2, percentile_75: 0.28, percentile_95: null,
        sample_size: 42, computed_at: "2026-05-03T00:00:00.000Z",
      },
    );
    const row = await service.getIndustryBenchmark("saas", "open_rate", "2026-Q2");
    expect(row?.id).toBe("row-1");
    expect(row?.sample_size).toBe(42);
  });
  it("returns null when no row matches", async () => {
    expect(await service.getIndustryBenchmark("saas", "x", "x")).toBeNull();
  });
});

// ─── Anonymizer (folded in) ──────────────────────────────────────────────────

describe("hashTenantId", () => {
  it("is deterministic and 16 hex chars", () => {
    expect(hashTenantId("tenant-1")).toBe(hashTenantId("tenant-1"));
    expect(hashTenantId("tenant-1")).toMatch(/^[0-9a-f]{16}$/);
    expect(hashTenantId("tenant-1")).not.toBe(hashTenantId("tenant-2"));
  });

  it("with a pepper stays deterministic but is not the plain sha256 (rainbow-table resistant)", () => {
    const pepper = "deployment-secret-pepper";
    // deterministic across calls with the same pepper (tenant can still find its row)
    expect(hashTenantId("tenant-1", pepper)).toBe(hashTenantId("tenant-1", pepper));
    expect(hashTenantId("tenant-1", pepper)).toMatch(/^[0-9a-f]{16}$/);
    // the peppered digest differs from the reversible unsalted one, so an
    // attacker's sha256 rainbow table cannot reverse the opaque_id
    expect(hashTenantId("tenant-1", pepper)).not.toBe(hashTenantId("tenant-1"));
    // different peppers → different opaque ids for the same tenant
    expect(hashTenantId("tenant-1", pepper)).not.toBe(hashTenantId("tenant-1", "other-pepper"));
  });

  it("anonymizeTenantRows threads the pepper through to opaque_id", () => {
    const pepper = "deployment-secret-pepper";
    const [row] = anonymizeTenantRows([{ tenant_id: "t1", kpi: 0.5 }], "tenant_id", pepper);
    expect(row!.opaque_id).toBe(hashTenantId("t1", pepper));
    expect(row!.opaque_id).not.toBe(hashTenantId("t1")); // not the reversible form
  });
});

describe("anonymizeTenantRows", () => {
  it("replaces tenant_id with opaque_id and keeps other fields", () => {
    const rows = [{ tenant_id: "t1", kpi: 0.5 }, { tenant_id: "t2", kpi: 0.7 }];
    const out = anonymizeTenantRows(rows);
    expect(out[0]!.opaque_id).toBe(hashTenantId("t1"));
    expect(out[0]!.kpi).toBe(0.5);
    expect(out[0]).not.toHaveProperty("tenant_id");
    // originals untouched
    expect(rows[0]!.tenant_id).toBe("t1");
  });
  it("falls back to 'anon' for non-string tenant ids", () => {
    const out = anonymizeTenantRows([{ tenant_id: 123 as unknown as string, kpi: 1 }]);
    expect(out[0]!.opaque_id).toBe("anon");
  });
});

describe("applyKAnonymity (suppression)", () => {
  it("suppresses the entire result when rows < k", () => {
    const rows = [1, 2, 3, 4];
    const out = applyKAnonymity(rows, MIN_K_ANONYMITY);
    expect(out.insufficient_data).toBe(true);
    expect(out.rows).toEqual([]);
    expect(out.k_threshold).toBe(5);
  });
  it("passes rows through when rows >= k", () => {
    const rows = [1, 2, 3, 4, 5];
    const out = applyKAnonymity(rows);
    expect(out.insufficient_data).toBe(false);
    expect(out.rows).toEqual(rows);
  });
});
