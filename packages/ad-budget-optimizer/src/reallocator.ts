/**
 * Realtime Budget Reallocator (ported from 実運用SaaS #358 / #1346).
 *
 * Detects triggers (CPA spike / ROAS drop), proposes shifts, runs safety
 * checks, persists proposals, and executes through per-platform adapters.
 * propose-only by default; auto_apply requires (a) env flag ON, (b) tenant
 * allow_auto_apply=TRUE, (c) all safety limits green.
 *
 * Decoupled from the original: Supabase → injected `ReallocationStore`,
 * concrete platform adapters → injected `AdPlatformAdapter` map. No env / DB.
 */

import type {
  AdPlatform,
  AdInsightRow,
  BudgetAllocationGuardrails,
  BudgetReallocationMode,
  BudgetReallocationProposal,
  BudgetReallocationTrigger,
  BudgetSafetyCheckResult,
  BudgetSafetyLimits,
} from "./types";
import type { ReallocationStore, ReallocationRow } from "./store";
import type { AdapterResult } from "./adapters/adapter";

/** Injectable platform adapters keyed by AdPlatform. */
export interface PlatformAdapters {
  meta?: (tenantId: string, row: ReallocationRow) => Promise<AdapterResult>;
  google?: (tenantId: string, row: ReallocationRow) => Promise<AdapterResult>;
  tiktok?: (tenantId: string, row: ReallocationRow) => Promise<AdapterResult>;
  linkedin?: (tenantId: string, row: ReallocationRow) => Promise<AdapterResult>;
}

const DEFAULT_LIMITS: Omit<BudgetSafetyLimits, "tenantId" | "updatedAt" | "updatedBy"> = {
  maxDailyShiftPct: 20,
  maxAbsoluteShiftJpy: 100_000,
  cooldownMinutes: 30,
  allowAutoApply: false,
  notifyOnPropose: true,
  notifyOnExecute: true,
};
const CPA_SPIKE_THRESHOLD_PCT = 50;
const ROAS_DROP_THRESHOLD_PCT = 30;
const VALID_PLATFORMS: AdPlatform[] = ["meta", "google", "linkedin", "tiktok"];

interface CampaignSnapshot {
  platform: AdPlatform;
  campaignId: string;
  spendJpy: number;
  revenueJpy: number;
  conversions: number;
  cpa: number;
  roas: number;
  dailyBudgetJpy: number;
  baselineCpa: number;
  baselineRoas: number;
}

export async function getSafetyLimits(
  store: ReallocationStore,
  tenantId: string,
): Promise<BudgetSafetyLimits> {
  const row = await store.getSafetyLimitsRow(tenantId);
  if (!row) {
    return { tenantId, ...DEFAULT_LIMITS, updatedAt: new Date(0).toISOString() };
  }
  return {
    tenantId,
    maxDailyShiftPct: Number(row.maxDailyShiftPct ?? DEFAULT_LIMITS.maxDailyShiftPct),
    maxAbsoluteShiftJpy: Number(row.maxAbsoluteShiftJpy ?? DEFAULT_LIMITS.maxAbsoluteShiftJpy),
    cooldownMinutes: Number(row.cooldownMinutes ?? DEFAULT_LIMITS.cooldownMinutes),
    allowAutoApply: Boolean(row.allowAutoApply),
    notifyOnPropose: Boolean(row.notifyOnPropose ?? true),
    notifyOnExecute: Boolean(row.notifyOnExecute ?? true),
    updatedAt: String(row.updatedAt ?? new Date().toISOString()),
    updatedBy: row.updatedBy ? String(row.updatedBy) : undefined,
  };
}

export function isSafetyCheckPassing(check: BudgetSafetyCheckResult): boolean {
  return check.withinDailyCap && check.withinAbsoluteCap && check.withinCooldown;
}

async function evaluateSafety(
  store: ReallocationStore,
  tenantId: string,
  source: { platform: AdPlatform; campaignId: string },
  currentDailyBudgetJpy: number,
  proposedDailyBudgetJpy: number,
  limits: BudgetSafetyLimits,
): Promise<BudgetSafetyCheckResult> {
  const deltaJpy = Math.abs(proposedDailyBudgetJpy - currentDailyBudgetJpy);
  const shiftPct = currentDailyBudgetJpy > 0 ? (deltaJpy / currentDailyBudgetJpy) * 100 : 100;
  const withinDailyCap = shiftPct <= limits.maxDailyShiftPct;
  const withinAbsoluteCap = deltaJpy <= limits.maxAbsoluteShiftJpy;

  const cutoff = new Date(Date.now() - limits.cooldownMinutes * 60_000).toISOString();
  const recent = await store.findRecentReallocations({
    tenantId,
    sourcePlatform: source.platform,
    sourceCampaignId: source.campaignId,
    afterIso: cutoff,
  });
  const withinCooldown = recent.length === 0;

  const limitsHit: string[] = [];
  if (!withinDailyCap) limitsHit.push("maxDailyShiftPct");
  if (!withinAbsoluteCap) limitsHit.push("maxAbsoluteShiftJpy");
  if (!withinCooldown) limitsHit.push("cooldownMinutes");

  return {
    withinDailyCap,
    withinAbsoluteCap,
    withinCooldown,
    limitsHit,
    computedAt: new Date().toISOString(),
  };
}

export async function detectReallocationTriggers(
  store: ReallocationStore,
  tenantId: string,
): Promise<BudgetReallocationTrigger[]> {
  const recentStart = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const baselineStart = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const rows = await store.getAdInsights(tenantId, baselineStart);
  if (!rows || rows.length === 0) return [];

  const snapshots = aggregateSnapshots(rows, recentStart);
  const triggers: BudgetReallocationTrigger[] = [];
  const detectedAt = new Date().toISOString();

  for (const snap of snapshots) {
    if (snap.baselineCpa > 0) {
      const pct = ((snap.cpa - snap.baselineCpa) / snap.baselineCpa) * 100;
      if (pct >= CPA_SPIKE_THRESHOLD_PCT) {
        triggers.push({
          type: "cpa_spike",
          description: `${snap.platform} ${snap.campaignId} の CPA が baseline +${pct.toFixed(1)}% に上昇`,
          metric: { name: "cpa", observedValue: snap.cpa, baselineValue: snap.baselineCpa, threshold: CPA_SPIKE_THRESHOLD_PCT },
          detectedAt,
        });
      }
    }
    if (snap.baselineRoas > 0) {
      const pct = ((snap.baselineRoas - snap.roas) / snap.baselineRoas) * 100;
      if (pct >= ROAS_DROP_THRESHOLD_PCT) {
        triggers.push({
          type: "roas_drop",
          description: `${snap.platform} ${snap.campaignId} の ROAS が baseline -${pct.toFixed(1)}% に低下`,
          metric: { name: "roas", observedValue: snap.roas, baselineValue: snap.baselineRoas, threshold: ROAS_DROP_THRESHOLD_PCT },
          detectedAt,
        });
      }
    }
  }
  return triggers;
}

function emptySnapshot(platform: AdPlatform, campaignId: string): CampaignSnapshot {
  return {
    platform,
    campaignId,
    spendJpy: 0,
    revenueJpy: 0,
    conversions: 0,
    cpa: 0,
    roas: 0,
    dailyBudgetJpy: 0,
    baselineCpa: 0,
    baselineRoas: 0,
  };
}

function accumulateSnapshot(snap: CampaignSnapshot, row: AdInsightRow, includeDailyBudget: boolean): void {
  snap.spendJpy += Number(row.spend_jpy ?? 0);
  snap.revenueJpy += Number(row.revenue_jpy ?? 0);
  snap.conversions += Number(row.conversions ?? 0);
  if (includeDailyBudget && row.daily_budget_jpy !== undefined) {
    snap.dailyBudgetJpy = Number(row.daily_budget_jpy);
  }
}

function finalizeMetrics(snap: CampaignSnapshot): CampaignSnapshot {
  snap.cpa = snap.conversions > 0 ? snap.spendJpy / snap.conversions : 0;
  snap.roas = snap.spendJpy > 0 ? snap.revenueJpy / snap.spendJpy : 0;
  snap.dailyBudgetJpy = snap.dailyBudgetJpy || snap.spendJpy / 7;
  return snap;
}

function aggregateSnapshots(rows: AdInsightRow[], recentStart: string): CampaignSnapshot[] {
  const recentByKey = new Map<string, CampaignSnapshot>();
  const baselineByKey = new Map<string, CampaignSnapshot>();
  for (const row of rows) {
    if (!VALID_PLATFORMS.includes(row.platform as AdPlatform)) continue;
    if (!row.date) continue;
    const platform = row.platform as AdPlatform;
    const key = `${row.platform}:${row.campaign_id}`;
    const target = row.date >= recentStart ? recentByKey : baselineByKey;
    const prev = target.get(key) ?? emptySnapshot(platform, row.campaign_id);
    accumulateSnapshot(prev, row, row.date >= recentStart);
    target.set(key, prev);
  }
  return Array.from(recentByKey.entries()).flatMap(([key, recent]) => {
    const baseline = baselineByKey.get(key);
    if (!baseline) return [];
    const current = finalizeMetrics(recent);
    const base = finalizeMetrics(baseline);
    current.baselineCpa = base.cpa;
    current.baselineRoas = base.roas;
    return [current];
  });
}

export async function proposeReallocation(
  store: ReallocationStore,
  tenantId: string,
  trigger: BudgetReallocationTrigger,
  source: { platform: AdPlatform; campaignId: string; currentDailyBudgetJpy: number },
  target: { platform: AdPlatform; campaignId: string },
  proposedDailyBudgetJpy: number,
  rationale: string,
  guardrails: BudgetAllocationGuardrails,
): Promise<BudgetReallocationProposal> {
  const limits = await getSafetyLimits(store, tenantId);
  const safetyCheck = await evaluateSafety(
    store,
    tenantId,
    source,
    source.currentDailyBudgetJpy,
    proposedDailyBudgetJpy,
    limits,
  );

  const effectiveMode: BudgetReallocationMode =
    guardrails.envEnabled &&
    guardrails.featureEnabled &&
    guardrails.tenantAllowsAutoApply &&
    isSafetyCheckPassing(safetyCheck)
      ? "auto_apply"
      : "propose_only";

  const deltaJpy = proposedDailyBudgetJpy - source.currentDailyBudgetJpy;
  const expectedLiftRoas = computeExpectedLift(trigger);

  return {
    trigger,
    mode: effectiveMode,
    source: { platform: source.platform, campaignId: source.campaignId },
    target,
    currentDailyBudgetJpy: source.currentDailyBudgetJpy,
    proposedDailyBudgetJpy,
    deltaJpy,
    expectedLiftRoas,
    rationale,
    safetyCheck,
  };
}

function computeExpectedLift(trigger: BudgetReallocationTrigger): number {
  if (trigger.type !== "cpa_spike" && trigger.type !== "roas_drop") return 0;
  const { baselineValue, observedValue } = trigger.metric;
  return baselineValue > 0 ? Math.abs((baselineValue - observedValue) / baselineValue) : 0;
}

export async function recordReallocation(
  store: ReallocationStore,
  tenantId: string,
  proposal: BudgetReallocationProposal,
  proposedBy: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  return store.insertReallocation(tenantId, proposal, proposedBy);
}

export interface ExecuteResult {
  ok: boolean;
  status: "executed" | "failed" | "rejected";
  error?: string;
}

async function executePlatformBudgetUpdate(
  adapters: PlatformAdapters,
  tenantId: string,
  row: ReallocationRow,
): Promise<{ ok: boolean; externalRef: string | null; error?: string }> {
  const platform = row.sourcePlatform as AdPlatform;
  const adapter = adapters[platform];
  if (!adapter) {
    return { ok: false, externalRef: null, error: `unsupported_platform:${platform}` };
  }
  const result = await adapter(tenantId, row);
  return {
    ok: result.ok,
    externalRef: result.ok ? `${platform}-${row.sourceCampaignId}` : null,
    error: result.error,
  };
}

export async function executeReallocation(
  store: ReallocationStore,
  adapters: PlatformAdapters,
  tenantId: string,
  reallocationId: string,
  executor: { email: string; auditLogId?: string },
  guardrails: BudgetAllocationGuardrails,
): Promise<ExecuteResult> {
  if (!guardrails.featureEnabled) return { ok: false, status: "rejected", error: "feature_disabled" };
  const row = await store.getReallocation(tenantId, reallocationId);
  if (!row) return { ok: false, status: "rejected", error: "not_found" };
  const safetyCheck = row.safetyCheck;
  if (!safetyCheck || !isSafetyCheckPassing(safetyCheck)) {
    return { ok: false, status: "rejected", error: "safety_check_failed" };
  }

  const mutation = await executePlatformBudgetUpdate(adapters, tenantId, row);
  const now = new Date().toISOString();

  if (!mutation.ok) {
    await store.updateReallocation(tenantId, reallocationId, {
      status: "failed",
      reviewedAt: now,
      reviewedBy: executor.email,
      rollbackReason: mutation.error ?? "mutation_failed",
      auditLogId: executor.auditLogId ?? null,
    });
    return { ok: false, status: "failed", error: mutation.error ?? "mutation_failed" };
  }

  const patch = await store.updateReallocation(tenantId, reallocationId, {
    status: "executed",
    executedAt: now,
    executedBy: executor.email,
    reviewedAt: now,
    reviewedBy: executor.email,
    auditLogId: executor.auditLogId ?? null,
    externalRef: mutation.externalRef,
  });
  if (!patch.ok) return { ok: false, status: "failed", error: patch.error };
  return { ok: true, status: "executed" };
}

export const __test = { evaluateSafety, aggregateSnapshots, computeExpectedLift };
