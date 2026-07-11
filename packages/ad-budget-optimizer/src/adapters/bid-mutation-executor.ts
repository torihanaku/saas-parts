/**
 * Ad bid mutation executor (ported from dev-dashboard-v2 #1459).
 *
 * Mirrors the budget executor but targets bid values. Two paths:
 *   - Google Ads: POST /customers/{id}/campaigns:mutate (target_cpa_micros)
 *   - Meta Ads:   POST /{campaignId} (bid_amount, bid_strategy)
 *
 * Safety limits: bids below BID_FLOOR_JPY (1,000) or above BID_CEILING_JPY
 * (100,000) are rejected without touching the proxy. Dry-run refuses to mutate.
 * The proxy and dry-run flag are injected via config.
 */

import type { ProxyFn } from "./adapter";

const GOOGLE_INTEGRATION_ID = "google-ads";
const META_INTEGRATION_ID = "meta-ads";
const DEFAULT_CONNECTION_ID = "default";

export const BID_FLOOR_JPY = 1_000;
export const BID_CEILING_JPY = 100_000;

export interface BidMutationInput {
  tenantId: string;
  bidMutationId: string;
  platform: "google" | "meta";
  campaignId: string;
  customerId?: string;
  newDailyBidJpy: number;
}

export interface BidMutationResult {
  ok: boolean;
  externalRef: string | null;
  error?: string;
}

export interface BidExecutorConfig {
  proxy: ProxyFn;
  /** When true, refuse to mutate (originally env.BID_MUTATION_DRY_RUN). */
  dryRun?: boolean;
}

/** Returns true when the executor is in no-mutation mode. Exposed for tests. */
export function isBidDryRunEnabled(config: BidExecutorConfig): boolean {
  return config.dryRun === true;
}

export async function applyBidChange(
  input: BidMutationInput,
  config: BidExecutorConfig,
): Promise<BidMutationResult> {
  if (isBidDryRunEnabled(config)) {
    return { ok: false, externalRef: null, error: "bid_mutation_dry_run_enabled" };
  }

  if (input.newDailyBidJpy < BID_FLOOR_JPY) {
    return { ok: false, externalRef: null, error: `bid_below_floor:${input.newDailyBidJpy}<${BID_FLOOR_JPY}` };
  }
  if (input.newDailyBidJpy > BID_CEILING_JPY) {
    return { ok: false, externalRef: null, error: `bid_above_ceiling:${input.newDailyBidJpy}>${BID_CEILING_JPY}` };
  }

  if (input.platform === "google") {
    return applyGoogleAdsBid(input, config);
  }
  if (input.platform === "meta") {
    return applyMetaAdsBid(input, config);
  }
  return { ok: false, externalRef: null, error: `unsupported_platform:${input.platform}` };
}

async function applyGoogleAdsBid(
  input: BidMutationInput,
  config: BidExecutorConfig,
): Promise<BidMutationResult> {
  if (!input.customerId) {
    return { ok: false, externalRef: null, error: "google_ads_customer_id_required" };
  }
  const targetCpaMicros = Math.round(input.newDailyBidJpy * 1_000_000);
  const campaignId = extractGoogleCampaignId(input.campaignId);
  const customerId = encodeURIComponent(input.customerId);
  const encodedCampaignId = encodeURIComponent(campaignId);
  const resourceName = `customers/${customerId}/campaigns/${encodedCampaignId}`;
  const endpoint = `customers/${customerId}/campaigns:mutate`;
  const body = {
    operations: [
      {
        update: { resource_name: resourceName, target_cpa: { target_cpa_micros: targetCpaMicros } },
        update_mask: "target_cpa.target_cpa_micros",
      },
    ],
  };
  const res = await config.proxy<{ results?: Array<{ resource_name?: string }> }>(
    input.tenantId,
    GOOGLE_INTEGRATION_ID,
    DEFAULT_CONNECTION_ID,
    "POST",
    endpoint,
    body,
  );
  if (!res) {
    return { ok: false, externalRef: null, error: "google_ads_bid_mutation_failed" };
  }
  const ref = res.data?.results?.[0]?.resource_name ?? null;
  return { ok: true, externalRef: ref ?? `google-bid-${campaignId}` };
}

function extractGoogleCampaignId(campaignIdOrResourceName: string): string {
  const match = campaignIdOrResourceName.match(/(?:^|\/)campaigns\/([^/]+)$/);
  return match?.[1] ?? campaignIdOrResourceName;
}

async function applyMetaAdsBid(
  input: BidMutationInput,
  config: BidExecutorConfig,
): Promise<BidMutationResult> {
  const endpoint = `${encodeURIComponent(input.campaignId)}`;
  const body = {
    bid_amount: Math.round(input.newDailyBidJpy),
    bid_strategy: "LOWEST_COST_WITH_BID_CAP",
  };
  const res = await config.proxy<{ id?: string; success?: boolean }>(
    input.tenantId,
    META_INTEGRATION_ID,
    DEFAULT_CONNECTION_ID,
    "POST",
    endpoint,
    body,
  );
  if (!res) {
    return { ok: false, externalRef: null, error: "meta_ads_bid_mutation_failed" };
  }
  if (res.data?.success === false) {
    return { ok: false, externalRef: null, error: "meta_ads_bid_mutation_rejected" };
  }
  const ref = res.data?.id ?? input.campaignId;
  return { ok: true, externalRef: `meta-bid-${ref}` };
}
