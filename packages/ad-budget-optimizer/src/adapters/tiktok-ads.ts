/**
 * TikTok Ads budget adapter (ported from dev-dashboard-v2 #1346).
 *
 * Updates a campaign-level daily budget via an injected proxy using TikTok
 * Business API v1.3's campaign update endpoint.
 */

import {
  ALWAYS_ENABLED,
  type AdPlatformAdapter,
  type AdapterOptions,
  type AdapterResult,
  type FeatureGate,
  type ProxyFn,
} from "./adapter";

export interface TikTokAdsBudgetUpdate {
  campaignId: string;
  advertiserId: string;
  dailyBudgetJpy: number;
  connectionId: string;
}

const INTEGRATION_ID = "tiktok-ads";
const CAMPAIGN_UPDATE_ENDPOINT = "/open_api/v1.3/campaign/update/";
const PLATFORM = "tiktok_ads" as const;

export function createTikTokAdsAdapter(
  proxy: ProxyFn,
  isEnabled: FeatureGate = ALWAYS_ENABLED,
): AdPlatformAdapter<typeof PLATFORM, TikTokAdsBudgetUpdate> {
  return {
    platform: PLATFORM,
    update: (tenantId, update, opts = {}) =>
      updateTikTokAdsBudget(tenantId, update, { proxyImpl: proxy, ...opts }, isEnabled),
  };
}

export async function updateTikTokAdsBudget(
  tenantId: string,
  update: TikTokAdsBudgetUpdate,
  opts: AdapterOptions,
  isEnabled: FeatureGate = ALWAYS_ENABLED,
): Promise<AdapterResult<typeof PLATFORM>> {
  if (!isEnabled()) {
    return { ok: false, platform: PLATFORM, campaignId: update.campaignId, error: "feature_flag_disabled" };
  }
  if (!update.campaignId || !update.connectionId || !update.advertiserId) {
    return { ok: false, platform: PLATFORM, campaignId: update.campaignId, error: "missing_required_fields" };
  }
  if (update.dailyBudgetJpy < 0) {
    return { ok: false, platform: PLATFORM, campaignId: update.campaignId, error: "negative_budget" };
  }

  if (opts.dry_run) {
    return { ok: true, platform: PLATFORM, campaignId: update.campaignId, dry: true };
  }

  const proxy = opts.proxyImpl;
  if (!proxy) {
    return { ok: false, platform: PLATFORM, campaignId: update.campaignId, error: "no_proxy_configured" };
  }
  const result = await proxy(
    tenantId,
    INTEGRATION_ID,
    update.connectionId,
    "POST",
    CAMPAIGN_UPDATE_ENDPOINT,
    {
      advertiser_id: update.advertiserId,
      campaign_id: update.campaignId,
      budget: update.dailyBudgetJpy,
    },
  );
  if (!result) {
    return { ok: false, platform: PLATFORM, campaignId: update.campaignId, error: "nango_proxy_failed" };
  }
  return { ok: true, platform: PLATFORM, campaignId: update.campaignId };
}
