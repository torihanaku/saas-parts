/**
 * Budget reallocation detection cron (ported from 実運用SaaS #1302).
 *
 * For every tenant that has recent ad-insights, it:
 *   1. detects CPA-spike / ROAS-drop triggers,
 *   2. skips (platform, campaign, trigger_type) tuples already proposed within
 *      the cooldown window (idempotency),
 *   3. proposes + records a new `proposed` row.
 *
 * Gated on an injected `isEnabled` flag — when OFF it returns immediately.
 * All persistence + trigger logic is injected via the store + reallocator fns.
 */

import type {
  AdPlatform,
  BudgetAllocationGuardrails,
  BudgetReallocationTrigger,
} from "./types";
import type { ReallocationStore } from "./store";
import {
  detectReallocationTriggers,
  proposeReallocation,
  recordReallocation,
} from "./reallocator";

const COOLDOWN_MINUTES = 30;
const DETECTION_GUARDRAILS: BudgetAllocationGuardrails = {
  envEnabled: false,
  featureEnabled: false,
  tenantAllowsAutoApply: false,
};

export interface DetectionRunSummary {
  status: "ran" | "disabled";
  tenantsScanned: number;
  triggersDetected: number;
  proposalsCreated: number;
  duplicatesSkipped: number;
}

export interface DetectionCronDeps {
  store: ReallocationStore;
  /** Feature gate (originally isEnabled("realtimeBudgetAllocation")). */
  isEnabled: () => boolean;
  /** Optional per-tenant error sink. */
  onError?: (context: string, err: Error) => void;
}

export async function runBudgetTriggerDetection(
  deps: DetectionCronDeps,
): Promise<DetectionRunSummary> {
  if (!deps.isEnabled()) {
    return {
      status: "disabled",
      tenantsScanned: 0,
      triggersDetected: 0,
      proposalsCreated: 0,
      duplicatesSkipped: 0,
    };
  }

  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const tenants = await deps.store.listTenantsWithAdInsights(since);
  let triggersDetected = 0;
  let proposalsCreated = 0;
  let duplicatesSkipped = 0;

  for (const tenantId of tenants) {
    try {
      const triggers = await detectReallocationTriggers(deps.store, tenantId);
      triggersDetected += triggers.length;
      for (const trigger of triggers) {
        const sourceCampaign = parseCampaignFromTrigger(trigger);
        if (!sourceCampaign) continue;

        const dup = await isDuplicate(deps.store, tenantId, sourceCampaign.platform, sourceCampaign.campaignId, trigger.type);
        if (dup) {
          duplicatesSkipped += 1;
          continue;
        }

        const currentBudget = await deps.store.getCurrentDailyBudget(tenantId, sourceCampaign.platform, sourceCampaign.campaignId);
        const proposed = currentBudget > 0 ? Math.round(currentBudget * 0.85) : 1000;

        const proposal = await proposeReallocation(
          deps.store,
          tenantId,
          trigger,
          { platform: sourceCampaign.platform, campaignId: sourceCampaign.campaignId, currentDailyBudgetJpy: currentBudget },
          { platform: sourceCampaign.platform, campaignId: sourceCampaign.campaignId },
          proposed,
          `Auto-detected ${trigger.type}: ${trigger.description}`,
          DETECTION_GUARDRAILS,
        );
        const rec = await recordReallocation(deps.store, tenantId, proposal, "system:budget-trigger-detection");
        if (rec.ok) proposalsCreated += 1;
      }
    } catch (e: unknown) {
      deps.onError?.("budget-trigger-detection", e instanceof Error ? e : new Error(String(e)));
    }
  }

  return {
    status: "ran",
    tenantsScanned: tenants.length,
    triggersDetected,
    proposalsCreated,
    duplicatesSkipped,
  };
}

function parseCampaignFromTrigger(
  trigger: BudgetReallocationTrigger,
): { platform: AdPlatform; campaignId: string } | null {
  const match = trigger.description.match(/^(\S+)\s+(\S+)\s+の/);
  if (!match) return null;
  const platform = match[1] as AdPlatform;
  return { platform, campaignId: match[2]! };
}

async function isDuplicate(
  store: ReallocationStore,
  tenantId: string,
  platform: AdPlatform,
  campaignId: string,
  triggerType: BudgetReallocationTrigger["type"],
): Promise<boolean> {
  const cutoff = new Date(Date.now() - COOLDOWN_MINUTES * 60_000).toISOString();
  const rows = await store.findRecentReallocations({
    tenantId,
    sourcePlatform: platform,
    sourceCampaignId: campaignId,
    afterIso: cutoff,
    triggerType,
  });
  return rows.length > 0;
}
