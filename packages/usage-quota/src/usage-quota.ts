/**
 * Usage quota — plan-based daily limits on metered actions.
 *
 * Ported from 実運用SaaS `server/lib/usage-limiter.ts` (enforceUsageLimit)
 * and the quota parts of `server/lib/user-context.ts`
 * (PLAN_LIMITS / getPlanLimits / getDailyUsage / trackUsage / checkUsageLimit).
 *
 * Coupling removed:
 * - Usage storage (was: supabase `dd_usage` table, count via content-range) is
 *   an injected `UsageStore`; an in-memory implementation is provided.
 * - Plan limit definitions (was: hardcoded PLAN_LIMITS + action→field limitMap)
 *   are caller config: a generic plan-key → per-action daily limits map.
 *   `EXAMPLE_PLAN_LIMITS` documents the source's free/pro/enterprise defaults.
 * - Auth / user-config resolution (was: getUserId + getOrCreateUserConfig over
 *   supabase `dd_user_config`) stays in the caller — pass userId/plan directly.
 *
 * Preserved behaviors:
 * - Daily window resets at UTC midnight; usage counted from `${today}T00:00:00Z`.
 * - Limit -1 means unlimited (allowed without counting), 0 blocks the action.
 * - Unknown actions fall back to a permissive default limit (999 in source).
 * - The 403 payload shape: { error, action, used, limit, plan, upgradeUrl, resetAt }.
 */

// ─── Storage ──────────────────────────────────────────────────────────────────

/** Replaces the `dd_usage` supabase table from the source. */
export interface UsageStore {
  /** Count usage events for (userId, action) created at or after `sinceIso` (ISO 8601 UTC). */
  countSince(userId: string, action: string, sinceIso: string): Promise<number>;
  /** Record a usage event (best-effort in the quota layer). */
  record(userId: string, action: string, tokensUsed: number): Promise<void>;
}

interface UsageEvent {
  userId: string;
  action: string;
  tokensUsed: number;
  createdAt: string;
}

/** In-memory implementation — suitable for tests and single-process dev. */
export class InMemoryUsageStore implements UsageStore {
  private readonly events: UsageEvent[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async countSince(userId: string, action: string, sinceIso: string): Promise<number> {
    const since = new Date(sinceIso).getTime();
    return this.events.filter(
      (e) =>
        e.userId === userId &&
        e.action === action &&
        new Date(e.createdAt).getTime() >= since,
    ).length;
  }

  async record(userId: string, action: string, tokensUsed: number): Promise<void> {
    this.events.push({ userId, action, tokensUsed, createdAt: this.now().toISOString() });
  }

  /** Test helper: all recorded events. */
  get all(): readonly UsageEvent[] {
    return this.events;
  }
}

// ─── Plan limit configuration ─────────────────────────────────────────────────

/** action → daily limit. -1 = unlimited, 0 = blocked. */
export type ActionLimits = Record<string, number>;

/** plan key → action limits. */
export type PlanLimitsMap = Record<string, ActionLimits>;

/**
 * Documented example — the source's free/pro/enterprise defaults, flattened
 * from PLAN_LIMITS (contentPerDay 等) through the source's action→field limitMap.
 */
export const EXAMPLE_PLAN_LIMITS: PlanLimitsMap = {
  free: {
    content_generate: 3, // contentPerDay
    intelligence_refresh: 5, // intelligenceRefresh
    intelligence_analyze: 1, // aiAnalysis
    action_suggest: 1, // aiAnalysis
    daily_dashboard_compose: 1, // aiAnalysis
    autopilot: 0, // autopilotPerDay
  },
  pro: {
    content_generate: 50,
    intelligence_refresh: 100,
    intelligence_analyze: 20,
    action_suggest: 20,
    daily_dashboard_compose: 20,
    autopilot: 50,
  },
  enterprise: {
    content_generate: 200,
    intelligence_refresh: 500,
    intelligence_analyze: 100,
    action_suggest: 100,
    daily_dashboard_compose: 100,
    autopilot: -1,
  },
};

// ─── UTC day helpers (preserve source reset semantics) ────────────────────────

/** Start of the current UTC day, e.g. "2026-07-11T00:00:00Z". */
export function utcDayStart(now: Date = new Date()): string {
  const today = now.toISOString().split("T")[0];
  return `${today}T00:00:00Z`;
}

/** Next UTC midnight — when daily quotas reset. */
export function nextUtcMidnight(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
}

// ─── Quota engine ─────────────────────────────────────────────────────────────

export interface CheckUsageResult {
  allowed: boolean;
  used: number;
  limit: number;
}

export interface UsageQuotaOptions {
  /** Injected usage storage (replaces the supabase `dd_usage` table). */
  store: UsageStore;
  /** Plan-key → per-action daily limits. See EXAMPLE_PLAN_LIMITS. */
  planLimits: PlanLimitsMap;
  /** Fallback plan when an unknown plan key is passed. @default "free" (source behavior) */
  defaultPlan?: string;
  /** Fallback limit for actions absent from the plan's map. @default 999 (source behavior) */
  defaultLimit?: number;
  /** Included in the 403 payload. @default "/pricing" (source behavior) */
  upgradeUrl?: string;
  /** Clock injection for tests. @default () => new Date() */
  now?: () => Date;
}

export class UsageQuota {
  private readonly store: UsageStore;
  private readonly planLimits: PlanLimitsMap;
  private readonly defaultPlan: string;
  private readonly defaultLimit: number;
  private readonly upgradeUrl: string;
  private readonly now: () => Date;

  constructor(options: UsageQuotaOptions) {
    this.store = options.store;
    this.planLimits = options.planLimits;
    this.defaultPlan = options.defaultPlan ?? "free";
    this.defaultLimit = options.defaultLimit ?? 999;
    this.upgradeUrl = options.upgradeUrl ?? "/pricing";
    this.now = options.now ?? (() => new Date());
  }

  /** Get action limits for a plan tier; unknown plans fall back to defaultPlan. */
  getPlanLimits(plan: string): ActionLimits {
    return this.planLimits[plan] ?? this.planLimits[this.defaultPlan] ?? {};
  }

  /** Daily limit for (plan, action); unknown actions get defaultLimit (999). */
  getActionLimit(plan: string, action: string): number {
    return this.getPlanLimits(plan)[action] ?? this.defaultLimit;
  }

  /** Get today's (UTC) usage count for a specific action. Returns 0 on store errors. */
  async getDailyUsage(userId: string, action: string): Promise<number> {
    try {
      return await this.store.countSince(userId, action, utcDayStart(this.now()));
    } catch {
      return 0;
    }
  }

  /** Track a usage event (best-effort — store failures are swallowed). */
  async trackUsage(userId: string, action: string, tokensUsed = 0): Promise<void> {
    try {
      await this.store.record(userId, action, tokensUsed);
    } catch {
      /* best-effort */
    }
  }

  /** Check if user has exceeded their daily limit for an action type. */
  async checkUsageLimit(
    userId: string,
    action: string,
    plan: string,
  ): Promise<CheckUsageResult> {
    const limit = this.getActionLimit(plan, action);
    if (limit === -1) return { allowed: true, used: 0, limit: -1 };
    const used = await this.getDailyUsage(userId, action);
    return { allowed: used < limit, used, limit };
  }

  /**
   * Enforce the quota for a request. Returns null when allowed; returns a
   * 403 Response (same payload shape as the source) when the limit is exceeded.
   * Unauthenticated requests (userId=null) are allowed through, matching the source.
   */
  async enforceUsageLimit(
    userId: string | null,
    action: string,
    plan: string,
  ): Promise<Response | null> {
    if (!userId) return null;

    const result = await this.checkUsageLimit(userId, action, plan);
    if (result.allowed) return null;

    const resetAt = nextUtcMidnight(this.now());
    return Response.json(
      {
        error: "usage_limit_exceeded",
        action,
        used: result.used,
        limit: result.limit,
        plan,
        upgradeUrl: this.upgradeUrl,
        resetAt: resetAt.toISOString(),
      },
      { status: 403 },
    );
  }
}
