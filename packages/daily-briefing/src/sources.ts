/**
 * ウィジェットデータフェッチャ (`ga4` / `costs` / `campaigns` / `sns`)。
 * 出典: dev-dashboard-v2 server/lib/widget-data/sources.ts (#721)。
 *
 * 移植方針:
 * - DB アクセス (`supabaseGet`) は `TableQuery` の注入に置換。
 * - 各 fetcher は「該当行が無ければ空配列」を返し UI が graceful に "no data" になる。
 *   マーケ由来のテーブル名 (dd_ad_insights 等) は既定値として保持しつつ config で差し替え可能。
 */
import type {
  DateRange,
  SourceParams,
  TableQuery,
  WidgetDataResponse,
} from "./types";

const DAYS: Record<DateRange, number> = {
  "1d": 1,
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "90d": 90,
};

function isoSince(range: DateRange): string {
  return new Date(Date.now() - DAYS[range] * 86_400_000).toISOString();
}

function dateOnlySince(range: DateRange): string {
  return isoSince(range).slice(0, 10);
}

function truncated<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
  if (rows.length <= limit) return { rows, truncated: false };
  return { rows: rows.slice(0, limit), truncated: true };
}

/** ドメイン依存のテーブル名 (マーケ由来)。config で差し替え可能。 */
export interface SourceTableConfig {
  integrations: string;
  adInsights: string;
  contentCalendar: string;
  /**
   * テナント分離のためのカラム名 (PostgREST フィルタ `<col>=eq.<tenantId>` に使う)。
   *
   * ⚠ マルチテナントで運用する場合は必須。省略したテーブルは **テナントで絞られず、
   * 全テナントのデータを横断で読む** (dev-dashboard-v2 は単一テナント製品だったため
   * 原文にはフィルタが無かった。汎用部品として cross-tenant leak を防ぐため注入式にした)。
   *
   * 例: `{ adInsights: "tenant_id", integrations: "tenant_id", contentCalendar: "project_id" }`
   * (原スキーマは dd_ad_insights=tenant_id / dd_content_calendar=project_id / integrations=無し)。
   */
  tenantColumns?: Partial<Record<"integrations" | "adInsights" | "contentCalendar", string>>;
}

export const DEFAULT_SOURCE_TABLES: SourceTableConfig = {
  integrations: "dashboard_integrations",
  adInsights: "dd_ad_insights",
  contentCalendar: "dd_content_calendar",
};

/**
 * テナントフィルタ節を組み立てる。
 * `tables.tenantColumns[which}` が設定されていれば `&<col>=eq.<encodedTenantId>` を返す。
 * 未設定なら空文字 (原文どおりフィルタ無し = 単一テナント運用)。
 */
function tenantClause(
  tables: SourceTableConfig,
  which: "integrations" | "adInsights" | "contentCalendar",
  tenantId: string,
): string {
  const col = tables.tenantColumns?.[which];
  if (!col) return "";
  return `&${col}=eq.${encodeURIComponent(tenantId)}`;
}

/**
 * GA4: 接続済み google_analytics integration の metrics_cache を平坦化。
 * integration が無ければ空配列。
 */
export function makeFetchGa4(
  query: TableQuery,
  tables: SourceTableConfig = DEFAULT_SOURCE_TABLES,
) {
  return async function fetchGa4(
    _params: SourceParams,
    tenantId: string,
  ): Promise<WidgetDataResponse> {
    const rows = (await query(
      tables.integrations,
      `select=metrics_cache,last_synced&type=eq.google_analytics&status=eq.connected${tenantClause(tables, "integrations", tenantId)}&order=last_synced.desc&limit=1`,
    )) as
      | { metrics_cache: Record<string, unknown> | null; last_synced: string | null }[]
      | null;

    if (!rows || rows.length === 0) {
      return { data: [], chartSpec: {}, truncated: false };
    }
    const cache = rows[0]?.metrics_cache ?? {};
    const flattened = Object.entries(cache).map(([metric, value]) => ({
      metric,
      value: typeof value === "number" ? value : Number(value) || 0,
    }));
    return {
      data: flattened as unknown as Record<string, unknown>[],
      chartSpec: { categoryKey: "metric", valueKey: "value" },
      truncated: false,
    };
  };
}

/** Costs: dd_ad_insights の日別 spend 合計。 */
export function makeFetchCosts(
  query: TableQuery,
  tables: SourceTableConfig = DEFAULT_SOURCE_TABLES,
) {
  return async function fetchCosts(
    params: SourceParams,
    tenantId: string,
  ): Promise<WidgetDataResponse> {
    const since = dateOnlySince(params.dateRange);
    const rows = (await query(
      tables.adInsights,
      `select=date,platform,spend&date=gte.${since}${tenantClause(tables, "adInsights", tenantId)}&order=date.asc&limit=2000`,
    )) as { date: string; platform: string; spend: number | null }[] | null;

    const byDay = new Map<string, number>();
    for (const r of rows ?? []) {
      byDay.set(r.date, (byDay.get(r.date) ?? 0) + Number(r.spend ?? 0));
    }
    const aggregated = Array.from(byDay.entries())
      .map(([date, spend]) => ({ date, spend: Number(spend.toFixed(2)) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const t = truncated(aggregated, params.limit);
    return {
      data: t.rows as unknown as Record<string, unknown>[],
      chartSpec: { xKey: "date", yKey: "spend" },
      truncated: t.truncated,
    };
  };
}

/** Campaigns: (platform, campaign_id) 別の spend / conversions / revenue 集計 + ROAS。 */
export function makeFetchCampaigns(
  query: TableQuery,
  tables: SourceTableConfig = DEFAULT_SOURCE_TABLES,
) {
  return async function fetchCampaigns(
    params: SourceParams,
    tenantId: string,
  ): Promise<WidgetDataResponse> {
    const since = dateOnlySince(params.dateRange);
    const rows = (await query(
      tables.adInsights,
      `select=campaign_id,platform,spend,conversions,revenue&date=gte.${since}${tenantClause(tables, "adInsights", tenantId)}&limit=2000`,
    )) as
      | {
          campaign_id: string;
          platform: string;
          spend: number | null;
          conversions: number | null;
          revenue: number | null;
        }[]
      | null;

    interface Agg {
      campaign_id: string;
      platform: string;
      spend: number;
      conversions: number;
      revenue: number;
    }
    const grouped = new Map<string, Agg>();
    for (const r of rows ?? []) {
      const key = `${r.platform}:${r.campaign_id}`;
      const cur = grouped.get(key) ?? {
        campaign_id: r.campaign_id,
        platform: r.platform,
        spend: 0,
        conversions: 0,
        revenue: 0,
      };
      cur.spend += Number(r.spend ?? 0);
      cur.conversions += Number(r.conversions ?? 0);
      cur.revenue += Number(r.revenue ?? 0);
      grouped.set(key, cur);
    }
    const aggregated = Array.from(grouped.values())
      .map((a) => ({
        ...a,
        spend: Number(a.spend.toFixed(2)),
        revenue: Number(a.revenue.toFixed(2)),
        roas: a.spend > 0 ? Number((a.revenue / a.spend).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);
    const t = truncated(aggregated, params.limit);
    return {
      data: t.rows as unknown as Record<string, unknown>[],
      chartSpec: { categoryKey: "campaign_id", valueKey: "revenue" },
      truncated: t.truncated,
    };
  };
}

/** SNS: dd_content_calendar の published 履歴を platform 別に集計。 */
export function makeFetchSns(
  query: TableQuery,
  tables: SourceTableConfig = DEFAULT_SOURCE_TABLES,
) {
  return async function fetchSns(
    params: SourceParams,
    tenantId: string,
  ): Promise<WidgetDataResponse> {
    const sinceIso = isoSince(params.dateRange);
    const rows = (await query(
      tables.contentCalendar,
      `select=status,platforms,published_at&status=eq.published&published_at=gte.${encodeURIComponent(sinceIso)}${tenantClause(tables, "contentCalendar", tenantId)}&limit=2000`,
    )) as { status: string; platforms: unknown; published_at: string | null }[] | null;

    const counts = new Map<string, number>();
    for (const r of rows ?? []) {
      const list = Array.isArray(r.platforms) ? (r.platforms as string[]) : [];
      if (list.length === 0) {
        counts.set("unknown", (counts.get("unknown") ?? 0) + 1);
        continue;
      }
      for (const p of list) {
        counts.set(String(p), (counts.get(String(p)) ?? 0) + 1);
      }
    }
    const aggregated = Array.from(counts.entries())
      .map(([platform, count]) => ({ platform, count }))
      .sort((a, b) => b.count - a.count);
    const t = truncated(aggregated, params.limit);
    return {
      data: t.rows as unknown as Record<string, unknown>[],
      chartSpec: { categoryKey: "platform", valueKey: "count" },
      truncated: t.truncated,
    };
  };
}
