/**
 * Industry Benchmark Aggregator — cross-tenant percentile aggregation with
 * k-anonymity guard and opt-in consent registry.
 *
 * Ported from dev-dashboard-v2 `server/lib/industry-benchmark-aggregator.ts`.
 * Supabase calls (dd_industry_benchmarks_safe / dd_tenant_benchmark_consent)
 * are replaced with an injected {@link BenchmarkStore}.
 *
 * Responsibilities:
 *   - aggregateIndustryKPIs(industry, kpi_name, period, samples)
 *       → returns IndustryBenchmark (percentiles + sample_size) when k-anonymity holds,
 *         otherwise null. Caller MUST treat null as "not enough opted-in tenants".
 *   - getIndustryBenchmark(industry, kpi_name, period)
 *       → fetches a pre-aggregated row (read path).
 *   - getTenantConsent(tenant_id) / setTenantConsent(tenant_id, share_level)
 *       → opt-in / opt-out registry.
 *   - listOptedInTenantIds(min_share_level)
 *       → caller (aggregation cron) feeds these tenants' raw KPI samples back into
 *         aggregateIndustryKPIs(); without this filter the cron would leak data
 *         from tenants that never opted in.
 */

import {
  BENCHMARK_K_ANON_MIN,
  type BenchmarkConsent,
  type IndustryBenchmark,
  type ShareLevel,
} from "./types";

// ─── Helpers (kept small + pure for unit-test coverage) ──────────────────────

/**
 * Linear interpolation percentile (matches NumPy's `linear` method).
 * Returns null when the sample is empty so the caller can branch on "no data".
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p < 0 || p > 100) {
    throw new Error(`percentile: p must be in [0,100], got ${p}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const fraction = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * fraction;
}

// ─── Aggregation (k-anonymized) ──────────────────────────────────────────────

/**
 * Compute percentile snapshot for an industry/kpi/period from raw samples.
 *
 * **k-anonymity guard**: returns `null` when fewer than BENCHMARK_K_ANON_MIN
 * tenants contributed. Callers must NOT persist the partial result.
 *
 * Caller is responsible for:
 *   - filtering `samples` to opted-in tenants (use listOptedInTenantIds()).
 *   - one sample per tenant (de-duplicate before passing in; otherwise the
 *     k-anon count is inflated by a single tenant's repeats).
 */
export function aggregateIndustryKPIs(
  industry: string,
  kpi_name: string,
  period: string,
  samples: number[],
  now: () => Date = () => new Date(),
): IndustryBenchmark | null {
  const sample_size = samples.length;
  if (sample_size < BENCHMARK_K_ANON_MIN) return null;

  return {
    id: "", // assigned by the persistence layer on insert
    industry,
    kpi_name,
    period,
    percentile_5: percentile(samples, 5),
    percentile_25: percentile(samples, 25),
    percentile_50: percentile(samples, 50),
    percentile_75: percentile(samples, 75),
    percentile_95: percentile(samples, 95),
    sample_size,
    computed_at: now().toISOString(),
  };
}

// ─── Store interface (mirrors the original query shapes) ─────────────────────

export interface StoreResult {
  ok: boolean;
  error?: string;
}

export interface BenchmarkStore {
  /**
   * `dd_industry_benchmarks_safe?industry=eq.…&kpi_name=eq.…&period=eq.…&order=computed_at.desc&limit=1`
   * — the "safe" read path must only ever surface rows with sample_size >= k.
   */
  getLatestBenchmark(
    industry: string,
    kpiName: string,
    period: string,
  ): Promise<IndustryBenchmark | null>;
  /** `dd_tenant_benchmark_consent?tenant_id=eq.…&limit=1` */
  getConsent(tenantId: string): Promise<BenchmarkConsent | null>;
  /** INSERT into dd_tenant_benchmark_consent */
  insertConsent(row: Record<string, unknown>): Promise<StoreResult>;
  /** PATCH dd_tenant_benchmark_consent?tenant_id=eq.… */
  patchConsent(tenantId: string, patch: Record<string, unknown>): Promise<StoreResult>;
  /** `dd_tenant_benchmark_consent?share_level=in.(…)&select=tenant_id` */
  listTenantIdsByShareLevels(levels: ShareLevel[]): Promise<string[]>;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface BenchmarkServiceOptions {
  store: BenchmarkStore;
  /** Clock injection for deterministic tests. Default: `() => new Date()`. */
  now?: () => Date;
}

export class BenchmarkService {
  private readonly store: BenchmarkStore;
  private readonly now: () => Date;

  constructor(options: BenchmarkServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  /** Compute a k-anonymized percentile snapshot (pure; delegates to aggregateIndustryKPIs). */
  aggregate(
    industry: string,
    kpiName: string,
    period: string,
    samples: number[],
  ): IndustryBenchmark | null {
    return aggregateIndustryKPIs(industry, kpiName, period, samples, this.now);
  }

  /** Look up a pre-aggregated benchmark via the safe read path. */
  async getIndustryBenchmark(
    industry: string,
    kpiName: string,
    period: string,
  ): Promise<IndustryBenchmark | null> {
    return this.store.getLatestBenchmark(industry, kpiName, period);
  }

  /** Fetch the consent row for a tenant. Returns a synthetic 'none' row if absent. */
  async getTenantConsent(tenantId: string): Promise<BenchmarkConsent> {
    const row = await this.store.getConsent(tenantId);
    if (row) return row;

    return {
      tenant_id: tenantId,
      share_level: "none",
      opted_in_at: null,
      opted_out_at: null,
      updated_at: new Date(0).toISOString(),
    };
  }

  /**
   * Update (or create) the consent row. Setting share_level to 'none' is
   * recorded as opt-out (opted_out_at), other values record opt-in
   * (opted_in_at).
   */
  async setTenantConsent(tenantId: string, shareLevel: ShareLevel): Promise<BenchmarkConsent> {
    const now = this.now().toISOString();
    const existing = await this.getTenantConsent(tenantId);
    const everPersisted = existing.updated_at !== new Date(0).toISOString();

    if (!everPersisted) {
      const insert: Record<string, unknown> = {
        tenant_id: tenantId,
        share_level: shareLevel,
        updated_at: now,
      };
      if (shareLevel === "none") {
        insert.opted_out_at = now;
      } else {
        insert.opted_in_at = now;
      }
      const result = await this.store.insertConsent(insert);
      if (!result.ok) {
        throw new Error(`benchmark consent insert failed: ${result.error ?? "unknown"}`);
      }
      return { ...existing, ...insert } as BenchmarkConsent;
    }

    const patch: Record<string, unknown> = { share_level: shareLevel, updated_at: now };
    if (shareLevel === "none") {
      patch.opted_out_at = now;
    } else {
      patch.opted_in_at = existing.opted_in_at ?? now;
    }
    const result = await this.store.patchConsent(tenantId, patch);
    if (!result.ok) {
      throw new Error(`benchmark consent patch failed: ${result.error ?? "unknown"}`);
    }
    return { ...existing, ...patch } as BenchmarkConsent;
  }

  /**
   * Return tenant_ids that have opted in at the given share level or higher.
   * 'none' < 'kpi_only' < 'patterns' < 'full'.
   *
   * Used by the aggregation cron so we never include data from tenants whose
   * consent is below the required level for that KPI.
   */
  async listOptedInTenantIds(
    minShareLevel: Exclude<ShareLevel, "none"> = "kpi_only",
  ): Promise<string[]> {
    const rank: Record<ShareLevel, number> = {
      none: 0,
      kpi_only: 1,
      patterns: 2,
      full: 3,
    };
    const allowed = (Object.keys(rank) as ShareLevel[]).filter(
      (lvl) => rank[lvl] >= rank[minShareLevel],
    );
    return this.store.listTenantIdsByShareLevels(allowed);
  }
}

// ─── In-memory implementation ────────────────────────────────────────────────

/** In-memory BenchmarkStore mirroring the PostgREST query semantics. */
export class InMemoryBenchmarkStore implements BenchmarkStore {
  /** Rows visible through the "safe" view. Callers should only seed rows with sample_size >= k. */
  benchmarks: IndustryBenchmark[] = [];
  consents: BenchmarkConsent[] = [];

  async getLatestBenchmark(
    industry: string,
    kpiName: string,
    period: string,
  ): Promise<IndustryBenchmark | null> {
    const rows = this.benchmarks
      .filter((b) => b.industry === industry && b.kpi_name === kpiName && b.period === period)
      .sort((a, b) => b.computed_at.localeCompare(a.computed_at));
    return rows[0] ?? null;
  }

  async getConsent(tenantId: string): Promise<BenchmarkConsent | null> {
    return this.consents.find((c) => c.tenant_id === tenantId) ?? null;
  }

  async insertConsent(row: Record<string, unknown>): Promise<StoreResult> {
    if (this.consents.some((c) => c.tenant_id === row.tenant_id)) {
      return { ok: false, error: "duplicate key" };
    }
    this.consents.push({
      tenant_id: String(row.tenant_id),
      share_level: row.share_level as ShareLevel,
      opted_in_at: (row.opted_in_at as string | undefined) ?? null,
      opted_out_at: (row.opted_out_at as string | undefined) ?? null,
      updated_at: String(row.updated_at),
    });
    return { ok: true };
  }

  async patchConsent(tenantId: string, patch: Record<string, unknown>): Promise<StoreResult> {
    const row = this.consents.find((c) => c.tenant_id === tenantId);
    if (!row) return { ok: false, error: "not found" };
    Object.assign(row, patch);
    return { ok: true };
  }

  async listTenantIdsByShareLevels(levels: ShareLevel[]): Promise<string[]> {
    const set = new Set(levels);
    return this.consents.filter((c) => set.has(c.share_level)).map((c) => c.tenant_id);
  }
}
