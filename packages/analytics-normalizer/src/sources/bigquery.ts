/**
 * BigQuery-style forecast data source (ported from dev-dashboard-v2
 * server/lib/marketing/data-sources/bigquery-adapter.ts).
 *
 * The original imported `@google-cloud/bigquery`. Here the actual query
 * execution is injected as `QueryExecutor`, so the package carries no cloud
 * SDK and no credentials — the SQL construction (the reusable part) is ported
 * faithfully.
 */

import type { ForecastDataSource, ForecastDataPoint, FetchDailySeriesParams } from "../data-source";

export interface BigQueryConfig {
  projectId: string;
  dataset: string;
  table: string;
  dateColumn: string;
  spendColumn: string;
  revenueColumn: string;
  conversionsColumn: string;
}

/** Runs a parameterized SQL query and returns raw rows (injected). */
export type QueryExecutor = (
  query: string,
  params: Record<string, string>,
) => Promise<Record<string, unknown>[]>;

function validateConfig(config: BigQueryConfig): void {
  for (const key of ["projectId", "dataset", "table", "dateColumn", "spendColumn", "revenueColumn", "conversionsColumn"] as const) {
    if (!config[key] || String(config[key]).length === 0) {
      throw new Error(`${key} is required`);
    }
  }
}

export class BigQueryDataSource implements ForecastDataSource {
  kind = "bigquery" as const;

  constructor(
    private config: BigQueryConfig,
    private exec: QueryExecutor,
  ) {
    validateConfig(config);
  }

  async fetchDailySeries(params: FetchDailySeriesParams): Promise<ForecastDataPoint[]> {
    const { projectId, dataset, table, dateColumn, spendColumn, revenueColumn, conversionsColumn } = this.config;

    let query = `
      SELECT
        CAST(${dateColumn} AS STRING) as date,
        SUM(${spendColumn}) as spend,
        SUM(${revenueColumn}) as revenue,
        SUM(${conversionsColumn}) as conversions
      FROM \`${projectId}.${dataset}.${table}\`
      WHERE ${dateColumn} BETWEEN @from AND @to
    `;

    const queryParams: Record<string, string> = { from: params.from, to: params.to };
    if (params.platform) {
      query += ` AND platform = @platform`;
      queryParams.platform = params.platform;
    }
    if (params.campaignId) {
      query += ` AND campaign_id = @campaignId`;
      queryParams.campaignId = params.campaignId;
    }
    query += ` GROUP BY date ORDER BY date ASC`;

    const rows = await this.exec(query, queryParams);
    return rows.map((r) => ({
      date: String(r.date),
      spend: Number(r.spend || 0),
      revenue: Number(r.revenue || 0),
      conversions: Number(r.conversions || 0),
      clicks: 0,
      impressions: 0,
    }));
  }
}

/** Factory for the registry. `config` must be a BigQueryConfig; exec is closed over. */
export function bigQueryFactory(exec: QueryExecutor) {
  return (config: unknown): ForecastDataSource => new BigQueryDataSource(config as BigQueryConfig, exec);
}
