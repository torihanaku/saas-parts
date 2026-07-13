/**
 * Injected persistence boundary for the realtime budget reallocator.
 *
 * The original 実運用SaaS code talked directly to Supabase (PostgREST
 * filter strings). Here that is abstracted into a small `ReallocationStore`
 * interface plus an in-memory implementation, so the package has no DB / no
 * `process.env` dependency.
 */

import type {
  AdInsightRow,
  BudgetReallocationProposal,
  BudgetSafetyCheckResult,
  BudgetSafetyLimits,
} from "./types";

/** A persisted reallocation row (subset of columns the reallocator touches). */
export interface ReallocationRow {
  id: string;
  tenantId: string;
  status: string;
  sourcePlatform: string;
  sourceCampaignId: string;
  triggerType: string;
  proposedAt: string; // ISO
  proposedDailyBudgetJpy: number;
  safetyCheck?: BudgetSafetyCheckResult;
  connectionId?: string;
  customerId?: string;
  budgetResourceName?: string;
  advertiserId?: string;
  externalRef?: string | null;
  [key: string]: unknown;
}

export interface RecentReallocationQuery {
  tenantId: string;
  sourcePlatform: string;
  sourceCampaignId: string;
  /** Only rows proposed strictly after this ISO timestamp count. */
  afterIso: string;
  /** Optional trigger-type filter (used by the detection cron idempotency). */
  triggerType?: string;
}

export interface ReallocationStore {
  /** Per-tenant safety limits row, or null when none configured (→ defaults). */
  getSafetyLimitsRow(tenantId: string): Promise<Partial<BudgetSafetyLimits> | null>;
  /** All ad-insight rows for a tenant since `sinceDate` (YYYY-MM-DD). */
  getAdInsights(tenantId: string, sinceDate: string): Promise<AdInsightRow[]>;
  /** Recent reallocations matching the query (for cooldown / de-dup checks). */
  findRecentReallocations(query: RecentReallocationQuery): Promise<ReallocationRow[]>;
  /** Persist a new proposal; returns the created row id. */
  insertReallocation(
    tenantId: string,
    proposal: BudgetReallocationProposal,
    proposedBy: string,
  ): Promise<{ ok: boolean; id?: string; error?: string }>;
  /** Load one reallocation by id (scoped to tenant). */
  getReallocation(tenantId: string, id: string): Promise<ReallocationRow | null>;
  /** Patch an existing reallocation row. */
  updateReallocation(
    tenantId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }>;
  /** Distinct tenant ids that have ad-insight rows since `sinceDate`. */
  listTenantsWithAdInsights(sinceDate: string): Promise<string[]>;
  /** Latest known daily budget for one source campaign. */
  getCurrentDailyBudget(
    tenantId: string,
    platform: string,
    campaignId: string,
  ): Promise<number>;
}

/**
 * A deterministic in-memory store for tests / demos. Seed it with insight rows
 * and safety limits; it records proposals in an internal array.
 */
export class InMemoryReallocationStore implements ReallocationStore {
  private rows: ReallocationRow[] = [];
  private seq = 0;

  constructor(
    private seed: {
      safetyLimits?: Record<string, Partial<BudgetSafetyLimits>>;
      adInsights?: AdInsightRow[];
      reallocations?: ReallocationRow[];
    } = {},
  ) {
    this.rows = [...(seed.reallocations ?? [])];
  }

  async getSafetyLimitsRow(tenantId: string): Promise<Partial<BudgetSafetyLimits> | null> {
    return this.seed.safetyLimits?.[tenantId] ?? null;
  }

  async getAdInsights(tenantId: string, sinceDate: string): Promise<AdInsightRow[]> {
    return (this.seed.adInsights ?? []).filter(
      (r) => (r as AdInsightRow & { tenant_id?: string }).tenant_id !== undefined
        ? (r as AdInsightRow & { tenant_id?: string }).tenant_id === tenantId && r.date >= sinceDate
        : r.date >= sinceDate,
    );
  }

  async findRecentReallocations(query: RecentReallocationQuery): Promise<ReallocationRow[]> {
    return this.rows.filter(
      (r) =>
        r.tenantId === query.tenantId &&
        r.sourcePlatform === query.sourcePlatform &&
        r.sourceCampaignId === query.sourceCampaignId &&
        r.proposedAt > query.afterIso &&
        (query.triggerType === undefined || r.triggerType === query.triggerType),
    );
  }

  async insertReallocation(
    tenantId: string,
    proposal: BudgetReallocationProposal,
    _proposedBy: string,
  ): Promise<{ ok: boolean; id?: string; error?: string }> {
    const id = `realloc-${++this.seq}`;
    this.rows.push({
      id,
      tenantId,
      status: "proposed",
      sourcePlatform: proposal.source.platform,
      sourceCampaignId: proposal.source.campaignId,
      triggerType: proposal.trigger.type,
      proposedAt: new Date().toISOString(),
      proposedDailyBudgetJpy: proposal.proposedDailyBudgetJpy,
      safetyCheck: proposal.safetyCheck,
    });
    return { ok: true, id };
  }

  async getReallocation(tenantId: string, id: string): Promise<ReallocationRow | null> {
    return this.rows.find((r) => r.id === id && r.tenantId === tenantId) ?? null;
  }

  async updateReallocation(
    tenantId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    const row = this.rows.find((r) => r.id === id && r.tenantId === tenantId);
    if (!row) return { ok: false, error: "not_found" };
    Object.assign(row, patch);
    return { ok: true };
  }

  async listTenantsWithAdInsights(sinceDate: string): Promise<string[]> {
    const set = new Set<string>();
    for (const r of this.seed.adInsights ?? []) {
      const tid = (r as AdInsightRow & { tenant_id?: string }).tenant_id;
      if (tid && r.date >= sinceDate) set.add(tid);
    }
    return Array.from(set);
  }

  async getCurrentDailyBudget(
    _tenantId: string,
    platform: string,
    campaignId: string,
  ): Promise<number> {
    const matches = (this.seed.adInsights ?? [])
      .filter((r) => r.platform === platform && r.campaign_id === campaignId)
      .sort((a, b) => b.date.localeCompare(a.date));
    return Number(matches[0]?.daily_budget_jpy ?? 0);
  }
}
