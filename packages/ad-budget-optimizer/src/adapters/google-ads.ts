/**
 * Google Ads budget adapter (ported from 実運用SaaS #1345).
 *
 * Updates a Google Ads campaign budget via an injected proxy. JPY amounts are
 * converted to micros (1 JPY = 1_000_000 micros). Mirrors the meta/tiktok
 * adapter shape so the reallocator can swap adapters polymorphically.
 */

import {
  ALWAYS_ENABLED,
  type AdPlatformAdapter,
  type AdapterOptions,
  type AdapterResult,
  type FeatureGate,
  type ProxyFn,
} from "./adapter";

export interface GoogleAdsBudgetUpdate {
  campaignId: string;
  budgetResourceName: string;
  dailyBudgetJpy: number;
  connectionId: string;
  customerId: string;
}

const INTEGRATION_ID = "google-ads";
const PLATFORM = "google_ads" as const;

export function createGoogleAdsAdapter(
  proxy: ProxyFn,
  isEnabled: FeatureGate = ALWAYS_ENABLED,
): AdPlatformAdapter<typeof PLATFORM, GoogleAdsBudgetUpdate> {
  return {
    platform: PLATFORM,
    update: (tenantId, update, opts = {}) =>
      updateGoogleAdsBudget(tenantId, update, { proxyImpl: proxy, ...opts }, isEnabled),
  };
}

export async function updateGoogleAdsBudget(
  tenantId: string,
  update: GoogleAdsBudgetUpdate,
  opts: AdapterOptions,
  isEnabled: FeatureGate = ALWAYS_ENABLED,
): Promise<AdapterResult<typeof PLATFORM>> {
  if (!isEnabled()) {
    return { ok: false, platform: PLATFORM, campaignId: update.campaignId, error: "feature_flag_disabled" };
  }
  if (
    !update.campaignId ||
    !update.connectionId ||
    !update.budgetResourceName ||
    !update.customerId
  ) {
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
  const microJpy = Math.round(update.dailyBudgetJpy * 1_000_000);
  const body = {
    operations: [
      {
        update: { resourceName: update.budgetResourceName, amountMicros: microJpy },
        updateMask: "amount_micros",
      },
    ],
  };
  const result = await proxy(
    tenantId,
    INTEGRATION_ID,
    update.connectionId,
    "POST",
    `/v17/customers/${update.customerId}/campaignBudgets:mutate`,
    body,
  );
  if (!result) {
    return { ok: false, platform: PLATFORM, campaignId: update.campaignId, error: "nango_proxy_failed" };
  }
  return { ok: true, platform: PLATFORM, campaignId: update.campaignId };
}
