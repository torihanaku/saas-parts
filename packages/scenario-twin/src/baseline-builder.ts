/**
 * Baseline builder (ported from dev-dashboard-v2 twin/baseline-builder).
 *
 * Builds a baseline from tenant-owned historical content + ad insight data.
 * Fails closed (throws `insufficient_baseline_data`) rather than persisting a
 * synthetic baseline when no historical rows exist. Data load + persistence are
 * injected via `TwinStore`.
 */

import type { BaselineMetrics } from "./types.js";
import type { ContentDraftRow, TwinStore } from "./store.js";

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function stats(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    mean: Number(mean.toFixed(2)),
    std: Number(Math.sqrt(variance).toFixed(2)),
  };
}

function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().split("T")[0]!;
}

function countByDay(
  rows: ContentDraftRow[],
  predicate: (row: ContentDraftRow) => boolean,
): number[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!predicate(row)) continue;
    const key = dateKey(row.created_at);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.values());
}

export async function buildBaseline(
  tenantId: string,
  store: TwinStore,
  windowDays = 90,
): Promise<string> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const { drafts, insights } = await store.loadBaselineInputs({
    tenantId,
    sinceIso: since,
  });

  if (drafts.length === 0 && insights.length === 0) {
    throw new Error("insufficient_baseline_data");
  }

  const metrics: BaselineMetrics = {
    blog_count: stats(countByDay(drafts, (row) => row.type === "article")),
    ad_budget: stats(insights.map((row) => toNumber(row.spend_jpy))),
    email_frequency: stats(countByDay(drafts, (row) => row.type === "email")),
    pv: stats(insights.map((row) => toNumber(row.impressions))),
    cv: stats(insights.map((row) => toNumber(row.conversions))),
  };

  return store.insertBaseline({
    tenantId,
    snapshotDate: new Date().toISOString(),
    windowDays,
    metrics,
    correlations: {},
  });
}

// Internal exports for testing only.
export const __testing = { stats, countByDay, toNumber, dateKey };
