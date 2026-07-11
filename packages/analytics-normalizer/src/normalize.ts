/**
 * Analytics normalization — unify heterogeneous metrics from GA4 / GSC /
 * Google Ads / Meta Ads into a common `NormalizedMetric` shape, then aggregate
 * and compute ROI / trends across sources.
 *
 * Ported verbatim (pure functions) from dev-dashboard-v2
 * server/lib/analytics-aggregator.ts. `aggregateByPeriod` originally read from
 * Supabase; here the snapshot rows are injected via a loader so the package is
 * self-contained.
 */

/** Analytics data source. Ad platforms mirror the source's `AdPlatform`. */
export type AdPlatform = "meta-ads" | "google-ads" | "linkedin-ads" | "tiktok-ads";
export type AnalyticsSource = "ga4" | "gsc" | AdPlatform;
export type MetricType = "traffic" | "conversion" | "cost" | "ranking" | "engagement";

export interface NormalizedMetric {
  source: AnalyticsSource;
  metric_type: MetricType;
  dimension: string;
  value: number;
  period_start: string;
  period_end: string;
  metadata?: Record<string, unknown>;
}

export interface AggregatedReport {
  period: { start: string; end: string };
  metrics_by_source: Record<string, NormalizedMetric[]>;
  totals: Record<string, number>;
  trends: Record<string, { current: number; previous: number; change_pct: number }>;
}

// ─── Normalization (pure) ────────────────────────────────────────────────────

export function normalizeGa4(raw: Record<string, unknown>[]): NormalizedMetric[] {
  return raw.map((r) => ({
    source: "ga4" as const,
    metric_type: guessMetricType(r),
    dimension: String(r.page_path ?? r.event_name ?? r.dimension ?? "unknown"),
    value: Number(r.value ?? r.sessions ?? r.pageviews ?? 0),
    period_start: String(r.period_start ?? r.date ?? ""),
    period_end: String(r.period_end ?? r.date ?? ""),
  }));
}

export function normalizeGsc(raw: Record<string, unknown>[]): NormalizedMetric[] {
  return raw.map((r) => ({
    source: "gsc" as const,
    metric_type: "ranking" as const,
    dimension: String(r.query ?? r.page ?? "unknown"),
    value: Number(r.clicks ?? 0),
    period_start: String(r.period_start ?? r.date ?? ""),
    period_end: String(r.period_end ?? r.date ?? ""),
    metadata: {
      impressions: Number(r.impressions ?? 0),
      ctr: Number(r.ctr ?? 0),
      position: Number(r.position ?? 0),
    },
  }));
}

export function normalizeGoogleAds(raw: Record<string, unknown>[]): NormalizedMetric[] {
  return raw.map((r) => ({
    source: "google-ads" as const,
    metric_type: "cost" as const,
    dimension: String(r.campaign_name ?? r.name ?? "unknown"),
    value: Number(r.cost ?? r.spend ?? 0),
    period_start: String(r.period_start ?? r.date ?? ""),
    period_end: String(r.period_end ?? r.date ?? ""),
    metadata: {
      clicks: Number(r.clicks ?? 0),
      impressions: Number(r.impressions ?? 0),
      conversions: Number(r.conversions ?? 0),
    },
  }));
}

export function normalizeMetaAds(raw: Record<string, unknown>[]): NormalizedMetric[] {
  return raw.map((r) => ({
    source: "meta-ads" as const,
    metric_type: "cost" as const,
    dimension: String(r.campaign_name ?? r.name ?? "unknown"),
    value: Number(r.spend ?? 0),
    period_start: String(r.period_start ?? r.date_start ?? ""),
    period_end: String(r.period_end ?? r.date_stop ?? ""),
    metadata: {
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      reach: Number(r.reach ?? 0),
    },
  }));
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/** Injected loader for persisted analytics snapshot rows. */
export type SnapshotLoader = (
  projectId: string,
  periodStart: string,
  periodEnd: string,
) => Promise<Record<string, unknown>[] | null>;

export async function aggregateByPeriod(
  loader: SnapshotLoader,
  projectId: string,
  periodStart: string,
  periodEnd: string,
): Promise<AggregatedReport> {
  const rows = await loader(projectId, periodStart, periodEnd);

  const metrics: NormalizedMetric[] = (rows ?? []).map((r) => ({
    source: String(r.source) as AnalyticsSource,
    metric_type: String(r.metric_type) as MetricType,
    dimension: String(r.dimension),
    value: Number(r.value),
    period_start: String(r.period_start),
    period_end: String(r.period_end),
    metadata: (r.metadata as Record<string, unknown>) ?? {},
  }));

  const metricsBySource: Record<string, NormalizedMetric[]> = {};
  for (const m of metrics) {
    (metricsBySource[m.source] ??= []).push(m);
  }

  const totals: Record<string, number> = {};
  for (const m of metrics) {
    const key = `${m.source}:${m.metric_type}`;
    totals[key] = (totals[key] ?? 0) + m.value;
  }

  return { period: { start: periodStart, end: periodEnd }, metrics_by_source: metricsBySource, totals, trends: {} };
}

export function computeRoi(
  costs: NormalizedMetric[],
  conversions: NormalizedMetric[],
): Record<string, number> {
  const costByDim: Record<string, number> = {};
  for (const c of costs) costByDim[c.dimension] = (costByDim[c.dimension] ?? 0) + c.value;

  const convByDim: Record<string, number> = {};
  for (const c of conversions) convByDim[c.dimension] = (convByDim[c.dimension] ?? 0) + c.value;

  const roi: Record<string, number> = {};
  for (const dim of Object.keys(costByDim)) {
    const cost = costByDim[dim] ?? 0;
    const conv = convByDim[dim] ?? 0;
    roi[dim] = cost > 0 ? (conv - cost) / cost : 0;
  }
  return roi;
}

export function computeTrends(
  current: NormalizedMetric[],
  previous: NormalizedMetric[],
): Record<string, { current: number; previous: number; change_pct: number }> {
  const sumByKey = (items: NormalizedMetric[]) => {
    const map: Record<string, number> = {};
    for (const m of items) {
      const key = `${m.source}:${m.metric_type}`;
      map[key] = (map[key] ?? 0) + m.value;
    }
    return map;
  };

  const cur = sumByKey(current);
  const prev = sumByKey(previous);
  const allKeys = new Set([...Object.keys(cur), ...Object.keys(prev)]);

  const trends: Record<string, { current: number; previous: number; change_pct: number }> = {};
  for (const key of allKeys) {
    const c = cur[key] ?? 0;
    const p = prev[key] ?? 0;
    trends[key] = { current: c, previous: p, change_pct: p > 0 ? ((c - p) / p) * 100 : 0 };
  }
  return trends;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function guessMetricType(r: Record<string, unknown>): MetricType {
  if (r.conversions != null || r.conversion_rate != null) return "conversion";
  if (r.cost != null || r.spend != null) return "cost";
  if (r.position != null || r.ctr != null) return "ranking";
  return "traffic";
}
