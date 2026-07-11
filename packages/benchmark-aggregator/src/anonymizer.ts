/**
 * Benchmark anonymizer.
 * Ported from dev-dashboard-v2 `server/lib/benchmark/anonymizer.ts` (same
 * benchmark system — folded in).
 *
 * Cross-company benchmark responses leak tenant names if raw rows are
 * returned. This module is the single chokepoint that converts internal
 * `tenant_id`s into opaque hash IDs and enforces k-anonymity.
 *
 * Two functions matter:
 *   - hashTenantId(tenantId) — sha256 hex, deterministic across requests
 *     so a tenant can find its own row in a public dataset
 *   - applyKAnonymity(rows, k) — drops the entire result when fewer than
 *     `k` rows are present, returning `{ insufficient_data: true }` so
 *     the UI can render a "not enough peers" state.
 */

import { createHash } from "node:crypto";

/** k = 5 for the per-tenant cross-company comparison path. Industry-level
 *  rollups (aggregateIndustryKPIs) use BENCHMARK_K_ANON_MIN = 10 for stricter
 *  privacy on aggregate publishing. */
export const MIN_K_ANONYMITY = 5;

export interface OpaqueRow {
  opaque_id: string;
  [key: string]: unknown;
}

export interface KAnonymousResult<T> {
  insufficient_data: boolean;
  k_threshold: number;
  rows: T[];
}

/**
 * Deterministic opaque ID — same tenantId always maps to the same hash so
 * the tenant can find itself in a public dataset. Truncated to 16 chars
 * to keep response payloads small while remaining collision-resistant for
 * realistic tenant counts (≤ 100k).
 */
export function hashTenantId(tenantId: string): string {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
}

/**
 * Replace every `tenant_id` field in a row set with an opaque hash. Mutates
 * a copy; original rows are untouched.
 */
export function anonymizeTenantRows<T extends Record<string, unknown>>(
  rows: T[],
  tenantIdKey: keyof T = "tenant_id" as keyof T,
): OpaqueRow[] {
  return rows.map((row) => {
    const tenantId = row[tenantIdKey];
    const { [tenantIdKey]: _omit, ...rest } = row;
    void _omit;
    return {
      ...(rest as Record<string, unknown>),
      opaque_id: typeof tenantId === "string" ? hashTenantId(tenantId) : "anon",
    };
  });
}

/**
 * Enforce k-anonymity at the response layer. When fewer than `k` rows are
 * present, returns `insufficient_data: true` and an empty rows array so
 * downstream code never accidentally surfaces 1-2 tenant data points that
 * could be re-identified.
 */
export function applyKAnonymity<T>(
  rows: T[],
  k: number = MIN_K_ANONYMITY,
): KAnonymousResult<T> {
  if (rows.length < k) {
    return { insufficient_data: true, k_threshold: k, rows: [] };
  }
  return { insufficient_data: false, k_threshold: k, rows };
}
