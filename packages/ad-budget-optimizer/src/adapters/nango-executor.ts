/**
 * Budget reallocation executor (ported from 実運用SaaS #1301).
 *
 * Bridges an execution decision and the real ad-platform APIs. Two paths:
 *   - Google Ads: POST /customers/{id}/campaignBudgets:mutate (amount_micros)
 *   - Meta Ads:   POST /{campaignId} (daily_budget)
 *
 * Safety mode: when `dryRun` is set (originally BUDGET_REALLOCATION_DRY_RUN)
 * the executor refuses to mutate and returns ok=false — a no-mutation canary
 * must not fabricate a synthetic external_ref.
 *
 * The Nango client (`proxyRequest`) and the dry-run flag are injected via the
 * config object rather than imported, so the package stays self-contained.
 */

import type { ProxyFn } from "./adapter";
import type { AdPlatform } from "../types";

const GOOGLE_INTEGRATION_ID = "google-ads";
const META_INTEGRATION_ID = "facebook-ads";
const DEFAULT_CONNECTION_ID = "default";

export interface BudgetMutationInput {
  tenantId: string;
  reallocationId: string;
  platform: AdPlatform;
  campaignId: string;
  newDailyBudgetJpy: number;
}

export interface BudgetMutationResult {
  ok: boolean;
  externalRef: string | null;
  error?: string;
}

export interface BudgetExecutorConfig {
  proxy: ProxyFn;
  /** When true, refuse to mutate (originally env.BUDGET_REALLOCATION_DRY_RUN). */
  dryRun?: boolean;
}

/** Returns true when the executor is in no-mutation mode. Exposed for tests. */
export function isDryRunEnabled(config: BudgetExecutorConfig): boolean {
  return config.dryRun === true;
}

/**
 * Execute one budget mutation. Returns ok=true with an external_ref on success;
 * ok=false with `error` on failure.
 */
export async function applyBudgetChange(
  input: BudgetMutationInput,
  config: BudgetExecutorConfig,
): Promise<BudgetMutationResult> {
  if (isDryRunEnabled(config)) {
    return { ok: false, externalRef: null, error: "budget_reallocation_dry_run_enabled" };
  }

  if (input.platform === "google") {
    return applyGoogleAds(input, config);
  }
  if (input.platform === "meta") {
    return applyMetaAds(input, config);
  }
  return { ok: false, externalRef: null, error: `unsupported_platform:${input.platform}` };
}

async function applyGoogleAds(
  input: BudgetMutationInput,
  config: BudgetExecutorConfig,
): Promise<BudgetMutationResult> {
  const amountMicros = Math.round(input.newDailyBudgetJpy * 1_000_000);
  const endpoint = `customers/${encodeURIComponent(input.campaignId)}/campaignBudgets:mutate`;
  const body = {
    operations: [
      {
        update: { resource_name: input.campaignId, amount_micros: amountMicros },
        update_mask: "amount_micros",
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
    return { ok: false, externalRef: null, error: "google_ads_mutation_failed" };
  }
  const ref = res.data?.results?.[0]?.resource_name ?? null;
  return { ok: true, externalRef: ref ?? `google-${input.campaignId}` };
}

async function applyMetaAds(
  input: BudgetMutationInput,
  config: BudgetExecutorConfig,
): Promise<BudgetMutationResult> {
  const endpoint = `${encodeURIComponent(input.campaignId)}`;
  const body = { daily_budget: Math.round(input.newDailyBudgetJpy) };
  const res = await config.proxy<{ id?: string; success?: boolean }>(
    input.tenantId,
    META_INTEGRATION_ID,
    DEFAULT_CONNECTION_ID,
    "POST",
    endpoint,
    body,
  );
  if (!res) {
    return { ok: false, externalRef: null, error: "meta_ads_mutation_failed" };
  }
  if (res.data?.success === false) {
    return { ok: false, externalRef: null, error: "meta_ads_mutation_rejected" };
  }
  const ref = res.data?.id ?? input.campaignId;
  return { ok: true, externalRef: `meta-${ref}` };
}
