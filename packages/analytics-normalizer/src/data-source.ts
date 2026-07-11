/**
 * Forecast data-source contract + registry (ported from dev-dashboard-v2
 * server/lib/marketing/data-source.ts + data-source-factory.ts).
 *
 * A `ForecastDataSource` returns a normalized daily time series. The registry
 * lets callers register source implementations by kind and instantiate them
 * from config. Two example source impls (BigQuery-style, Supabase-style) ship
 * with the package but take injected executors instead of the real SDK / DB.
 */

export type DataSourceKind = "supabase_ad_insights" | "bigquery" | "sheets" | "csv" | "excel" | (string & {});

export interface ForecastDataPoint {
  date: string; // ISO YYYY-MM-DD
  spend: number;
  revenue: number;
  conversions: number;
  clicks?: number;
  impressions?: number;
}

export interface FetchDailySeriesParams {
  tenantId: string;
  from: string;
  to: string;
  platform?: string;
  campaignId?: string;
}

export interface ForecastDataSource {
  kind: DataSourceKind;
  fetchDailySeries(params: FetchDailySeriesParams): Promise<ForecastDataPoint[]>;
}

/** Factory: given config, produce a data source instance. */
export type DataSourceFactory = (config: unknown) => ForecastDataSource;

/**
 * Registry of source-kind → factory. Register example impls (or your own) and
 * create sources by kind.
 */
export class DataSourceRegistry {
  private factories = new Map<string, DataSourceFactory>();

  register(kind: DataSourceKind, factory: DataSourceFactory): this {
    this.factories.set(kind, factory);
    return this;
  }

  isSupported(kind: string): boolean {
    return this.factories.has(kind);
  }

  supportedKinds(): string[] {
    return Array.from(this.factories.keys());
  }

  create(kind: DataSourceKind, config: unknown): ForecastDataSource {
    const factory = this.factories.get(kind);
    if (!factory) throw new Error(`Unsupported data source kind: ${kind}`);
    return factory(config);
  }
}
