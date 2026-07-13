/**
 * Ad-insight sync connector (ported from 実運用SaaS
 * server/lib/marketing/connectors/{linkedin,tiktok}.ts).
 *
 * Both source connectors were byte-for-byte identical except for the platform
 * keyword. This is the shared connector, parameterized by platform, with the
 * Nango client (`listConnections` / `listRecords`) and the insert sink
 * injected. `createLinkedinConnector` / `createTiktokConnector` are provided as
 * injectable examples.
 */

export interface RawInsightRecord {
  id?: unknown;
  campaign_id?: unknown;
  campaignId?: unknown;
  campaign_name?: unknown;
  campaignName?: unknown;
  date?: unknown;
  start_date?: unknown;
  spend?: unknown;
  cost?: unknown;
  spend_jpy?: unknown;
  revenue?: unknown;
  revenue_jpy?: unknown;
  conversions?: unknown;
  clicks?: unknown;
  impressions?: unknown;
}

export interface NangoConnection {
  connection_id: string;
  provider_config_key: string;
  provider?: string;
}

export interface SyncOptions {
  connectionId?: string;
  integrationId?: string;
}

/** Injected Nango-style client. */
export interface ConnectorClient {
  listConnections(tenantId: string): Promise<NangoConnection[]>;
  listRecords<T>(
    tenantId: string,
    integrationId: string,
    connectionId: string,
    model: string,
    opts: { limit: number },
  ): Promise<{ records: T[] }>;
}

/** Injected persistence sink for one normalized insight row. */
export type InsertFn = (row: Record<string, unknown>) => Promise<unknown>;

export interface ConnectorLogger {
  info?(scope: string, message: string): void;
  error?(scope: string, err: Error): void;
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeInsight(record: RawInsightRecord, platform: string, fallbackDate: string): Record<string, unknown> {
  const campaignId =
    toStringValue(record.campaign_id) ??
    toStringValue(record.campaignId) ??
    toStringValue(record.id) ??
    `${platform}-unknown-campaign`;
  return {
    campaign_id: campaignId,
    campaign_name: toStringValue(record.campaign_name) ?? toStringValue(record.campaignName),
    date: toStringValue(record.date) ?? toStringValue(record.start_date) ?? fallbackDate,
    spend_jpy: toNumber(record.spend_jpy ?? record.spend ?? record.cost),
    revenue_jpy: toNumber(record.revenue_jpy ?? record.revenue),
    conversions: toNumber(record.conversions),
    clicks: toNumber(record.clicks),
    impressions: toNumber(record.impressions),
  };
}

export interface ConnectorDeps {
  client: ConnectorClient;
  insert: InsertFn;
  logger?: ConnectorLogger;
}

export interface AdInsightConnector {
  readonly platform: string;
  /** keyword used to match a Nango connection (e.g. "linkedin"). */
  readonly providerKeyword: string;
  sync(tenantId: string, fromDate: string, toDate: string, options?: SyncOptions): Promise<{ inserted: number }>;
}

/**
 * Build an ad-insight sync connector for one platform. `providerKeyword` is
 * used to auto-discover the matching Nango connection when explicit ids are
 * not supplied.
 */
export function createAdInsightConnector(
  platform: string,
  providerKeyword: string,
  deps: ConnectorDeps,
): AdInsightConnector {
  const scope = `marketing.sync.${platform}`;

  async function resolveConnection(
    tenantId: string,
    options: SyncOptions,
  ): Promise<{ connectionId: string; integrationId: string } | null> {
    if (options.connectionId && options.integrationId) {
      return { connectionId: options.connectionId, integrationId: options.integrationId };
    }
    const connections = await deps.client.listConnections(tenantId);
    const connection = connections.find((conn) => {
      const key = `${conn.provider_config_key ?? ""} ${conn.provider ?? ""}`.toLowerCase();
      return key.includes(providerKeyword);
    });
    if (!connection) return null;
    return { connectionId: connection.connection_id, integrationId: connection.provider_config_key };
  }

  return {
    platform,
    providerKeyword,
    async sync(tenantId, fromDate, toDate, options = {}) {
      try {
        const connection = await resolveConnection(tenantId, options);
        if (!connection) {
          deps.logger?.info?.(scope, `No ${platform} Ads connection configured for ${tenantId}`);
          return { inserted: 0 };
        }

        deps.logger?.info?.(scope, `Syncing ${platform} Ads for ${tenantId} from ${fromDate} to ${toDate}`);

        const { records } = await deps.client.listRecords<RawInsightRecord>(
          tenantId,
          connection.integrationId,
          connection.connectionId,
          "ad-insights",
          { limit: 100 },
        );

        let inserted = 0;
        for (const record of records) {
          const normalized = normalizeInsight(record, platform, fromDate);
          await deps.insert({ tenant_id: tenantId, platform, ...normalized });
          inserted++;
        }
        return { inserted };
      } catch (err: unknown) {
        deps.logger?.error?.(scope, err instanceof Error ? err : new Error(String(err)));
        return { inserted: 0 };
      }
    },
  };
}

/** LinkedIn Ads connector example. */
export function createLinkedinConnector(deps: ConnectorDeps): AdInsightConnector {
  return createAdInsightConnector("linkedin", "linkedin", deps);
}

/** TikTok Ads connector example. */
export function createTiktokConnector(deps: ConnectorDeps): AdInsightConnector {
  return createAdInsightConnector("tiktok", "tiktok", deps);
}
