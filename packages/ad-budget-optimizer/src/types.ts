/**
 * Shared types for ad budget optimization / realtime reallocation.
 *
 * Ported from 実運用SaaS `shared/types/budget-allocation.ts`, trimmed to
 * what this package needs and made self-contained (no @torihanaku/* imports).
 */

export type AdPlatform = "meta" | "google" | "linkedin" | "tiktok";

export type BudgetReallocationMode = "propose_only" | "auto_apply";

export type BudgetReallocationStatus =
  | "proposed"
  | "approved"
  | "executed"
  | "rejected"
  | "failed"
  | "rolled_back";

export type BudgetReallocationTriggerType =
  | "cpa_spike"
  | "roas_drop"
  | "budget_pacing"
  | "time_window"
  | "manual";

export interface BudgetReallocationTrigger {
  type: BudgetReallocationTriggerType;
  /** Human-readable explanation (Japanese) of why this trigger fired. */
  description: string;
  metric: {
    name: string;
    observedValue: number;
    baselineValue: number;
    threshold: number;
  };
  detectedAt: string;
}

export interface BudgetSafetyLimits {
  tenantId: string;
  /** Max % of daily budget that can move in a single reallocation (0-100). */
  maxDailyShiftPct: number;
  /** Hard absolute ceiling per reallocation (in JPY). */
  maxAbsoluteShiftJpy: number;
  /** Minimum gap (minutes) between reallocations on the same campaign pair. */
  cooldownMinutes: number;
  /** When false, auto_apply mode is forbidden regardless of env flag. */
  allowAutoApply: boolean;
  notifyOnPropose: boolean;
  notifyOnExecute: boolean;
  updatedAt: string;
  updatedBy?: string;
}

export interface BudgetSafetyCheckResult {
  withinDailyCap: boolean;
  withinAbsoluteCap: boolean;
  withinCooldown: boolean;
  /** Names of the limits that were violated, e.g. ["maxDailyShiftPct"]. */
  limitsHit: string[];
  computedAt: string;
}

export interface BudgetReallocationProposal {
  trigger: BudgetReallocationTrigger;
  mode: BudgetReallocationMode;
  source: { platform: AdPlatform; campaignId: string };
  target: { platform: AdPlatform; campaignId: string };
  currentDailyBudgetJpy: number;
  proposedDailyBudgetJpy: number;
  deltaJpy: number;
  expectedLiftRoas: number;
  rationale: string;
  safetyCheck: BudgetSafetyCheckResult;
}

export interface BudgetAllocationGuardrails {
  /** ENABLE_REALTIME_BUDGET_ALLOCATION env flag value. */
  envEnabled: boolean;
  /** server-resolved feature flag (env AND override layers). */
  featureEnabled: boolean;
  /** tenant-level safety toggle. */
  tenantAllowsAutoApply: boolean;
  /** Effective mode: auto_apply only when ALL three above are true. */
  effectiveMode?: BudgetReallocationMode;
}

/** Raw ad-insights row (one platform/campaign/day). */
export interface AdInsightRow {
  date: string;
  platform: string;
  campaign_id: string;
  spend_jpy: number;
  revenue_jpy: number;
  conversions: number;
  daily_budget_jpy?: number;
}
