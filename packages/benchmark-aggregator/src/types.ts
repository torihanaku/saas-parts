/**
 * Industry Benchmark — shared types.
 * Ported from dev-dashboard-v2 `shared/types/benchmark.ts`.
 */

/** Minimum sample size for a benchmark row to be visible (k-anonymity threshold). */
export const BENCHMARK_K_ANON_MIN = 10;

/**
 * Tenant data-sharing level for cross-company benchmarks.
 *  - none      : no data shared. Aggregation jobs MUST exclude this tenant.
 *  - kpi_only  : numeric KPI values only.
 *  - patterns  : KPI + anonymized campaign / channel patterns.
 *  - full      : KPI + patterns + creative meta (still anonymized).
 */
export type ShareLevel = "none" | "kpi_only" | "patterns" | "full";

export const SHARE_LEVELS: readonly ShareLevel[] = [
  "none",
  "kpi_only",
  "patterns",
  "full",
] as const;

/**
 * A k-anonymized industry benchmark row.
 * `sample_size` is guaranteed >= BENCHMARK_K_ANON_MIN.
 * `percentile_*` may be null only during seed / cold-start.
 */
export interface IndustryBenchmark {
  id: string;
  industry: string;
  kpi_name: string;
  period: string;
  percentile_5: number | null;
  percentile_25: number | null;
  percentile_50: number | null;
  percentile_75: number | null;
  percentile_95: number | null;
  sample_size: number;
  computed_at: string;
}

/** Tenant-scoped opt-in record. */
export interface BenchmarkConsent {
  tenant_id: string;
  share_level: ShareLevel;
  opted_in_at: string | null;
  opted_out_at: string | null;
  updated_at: string;
}

/** Request body shape for a consent update. */
export interface BenchmarkConsentUpdate {
  share_level: ShareLevel;
}
