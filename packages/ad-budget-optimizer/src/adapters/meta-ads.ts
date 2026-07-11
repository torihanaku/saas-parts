/**
 * Meta Ads budget adapter (ported from dev-dashboard-v2 #1344).
 *
 * Updates a Meta Marketing API campaign daily budget via an injected proxy.
 * Always supports dry_run. Returns ok=false instead of throwing.
 */

import {
  ALWAYS_ENABLED,
  type AdPlatformAdapter,
  type AdapterOptions,
  type AdapterResult,
  type FeatureGate,
  type ProxyFn,
} from "./adapter";

export interface MetaAdsBudgetUpdate {
  campaignId: string;
  dailyBudgetJpy: number;
  connectionId: string;
}

const INTEGRATION_ID = "meta-ads";
const PLATFORM = "meta_ads" as const;

export function createMetaAdsAdapter(
  proxy: ProxyFn,
  isEnabled: FeatureGate = ALWAYS_ENABLED,
): AdPlatformAdapter<typeof PLATFORM, MetaAdsBudgetUpdate> {
  return {
    platform: PLATFORM,
    update: (tenantId, update, opts = {}) =>
      updateMetaAdsBudget(tenantId, update, { proxyImpl: proxy, ...opts }, isEnabled),
  };
}

export async function updateMetaAdsBudget(
  tenantId: string,
  update: MetaAdsBudgetUpdate,
  opts: AdapterOptions,
  isEnabled: FeatureGate = ALWAYS_ENABLED,
): Promise<AdapterResult<typeof PLATFORM>> {
  if (!isEnabled()) {
    return { ok: false, platform: PLATFORM, campaignId: update.campaignId, error: "feature_flag_disabled" };
  }
  if (!update.campaignId || !update.connectionId) {
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
    `/${update.campaignId}`,
    { daily_budget: update.dailyBudgetJpy },
  );
  if (!result) {
    return { ok: false, platform: PLATFORM, campaignId: update.campaignId, error: "nango_proxy_failed" };
  }
  return { ok: true, platform: PLATFORM, campaignId: update.campaignId };
}
