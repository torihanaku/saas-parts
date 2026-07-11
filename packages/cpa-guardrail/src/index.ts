/**
 * CPA guardrail (ported from dev-dashboard-v2 server/services/cpaGuardrail.ts
 * + server/jobs/cpaGuardrailCheck.ts).
 *
 * Watches campaign CPA (spend / conversions) against a threshold and, when a
 * campaign exceeds it, creates a **proposal** to pause the campaign. It never
 * auto-pauses (propose-only, human approval required — "Lesson 3" from the
 * source). The actual pause action is an injected callback that the caller
 * wires to its ad-platform API.
 *
 * Decoupled from the original:
 *   - Supabase           → injected `GuardrailStore`
 *   - Slack notify        → injected `NotifyFn`
 *   - ad-pause execution   → injected `PauseFn` (only called on human approval)
 *   - hard-coded TARGET_CPA → `GuardrailConfig.targetCpa`
 *
 * No `@torihanaku/*` imports, no `process.env`, no DB, no secrets.
 */

export { InMemoryGuardrailStore } from "./memory-store";

export interface AdInsight {
  platform: string;
  campaign_id: string;
  spend: number;
  conversions: number;
}

export interface Proposal {
  id: string;
  platform: string;
  campaign_id: string;
  metric: string;
  threshold: number;
  actual_value: number;
  status?: string;
  proposed_action?: string;
}

export interface GuardrailConfig {
  /** Target CPA; the threshold is `targetCpa * thresholdMultiplier`. */
  targetCpa: number;
  /** Multiplier applied to targetCpa (default 1.5 — "CPA > target × 1.5"). */
  thresholdMultiplier?: number;
}

/** Injected persistence boundary. */
export interface GuardrailStore {
  /** Ad insights for one tenant on the given ISO date (YYYY-MM-DD). */
  getInsights(tenantId: string, date: string): Promise<AdInsight[]>;
  /** Persist a new guardrail proposal; returns the created row (with id). */
  insertProposal(proposal: Omit<Proposal, "id">): Promise<Proposal>;
  /** Distinct tenant ids to scan (originally `teams`). */
  listTenantIds(): Promise<string[]>;
}

/** Slack / chat notification sink. */
export type NotifyFn = (tenantId: string, message: string) => Promise<void> | void;

/** Injected error/info logger. */
export interface GuardrailLogger {
  info?(message: string): void;
  error?(message: string, err?: unknown): void;
}

const DEFAULT_MULTIPLIER = 1.5;

function isoDateYesterday(now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0]!;
}

/**
 * Check one tenant's CPA guardrail. Returns the list of created proposals
 * (propose-only; NO auto-pause). Calls `notify` per proposal when provided.
 */
export async function checkCpaGuardrail(
  tenantId: string,
  deps: {
    store: GuardrailStore;
    config: GuardrailConfig;
    notify?: NotifyFn;
    logger?: GuardrailLogger;
    /** Override the "recent performance" date (defaults to yesterday). */
    date?: string;
  },
): Promise<Proposal[]> {
  const { store, config, notify, logger } = deps;
  const dateStr = deps.date ?? isoDateYesterday();

  let insights: AdInsight[];
  try {
    insights = await store.getInsights(tenantId, dateStr);
  } catch (err) {
    logger?.error?.("Failed to fetch ad insights for CPA check", err);
    return [];
  }
  if (!insights) return [];

  const threshold = config.targetCpa * (config.thresholdMultiplier ?? DEFAULT_MULTIPLIER);
  const proposals: Proposal[] = [];

  for (const insight of insights) {
    if (insight.conversions > 0) {
      const cpa = insight.spend / insight.conversions;
      if (cpa > threshold) {
        const proposal = await store.insertProposal({
          platform: insight.platform,
          campaign_id: insight.campaign_id,
          metric: "CPA",
          threshold,
          actual_value: cpa,
          status: "pending",
          proposed_action: "pause",
        });
        if (proposal) {
          proposals.push(proposal);
          await notify?.(
            tenantId,
            `CPA Guardrail Alert: Campaign ${insight.campaign_id} on ${insight.platform} has CPA of ${cpa.toFixed(2)} (Threshold: ${threshold}). Proposal created to pause. Please approve via Dashboard.`,
          );
        }
      }
    }
  }

  return proposals;
}

/**
 * Run the CPA guardrail check across all tenants. Errors from one tenant do
 * not halt the loop.
 */
export async function runCpaGuardrailCheck(deps: {
  store: GuardrailStore;
  config: GuardrailConfig;
  notify?: NotifyFn;
  logger?: GuardrailLogger;
}): Promise<{ tenantsScanned: number; proposalsCreated: number }> {
  const { store, logger } = deps;
  let tenants: string[];
  try {
    tenants = await store.listTenantIds();
  } catch (err) {
    logger?.error?.("Failed to fetch tenants for CPA check", err);
    return { tenantsScanned: 0, proposalsCreated: 0 };
  }

  let proposalsCreated = 0;
  for (const tenantId of tenants) {
    try {
      const proposals = await checkCpaGuardrail(tenantId, deps);
      if (proposals.length > 0) {
        proposalsCreated += proposals.length;
        logger?.info?.(`[CPA Guardrail] Tenant ${tenantId}: Created ${proposals.length} proposals.`);
      }
    } catch (e) {
      logger?.error?.(`[CPA Guardrail] Failed for tenant ${tenantId}`, e);
    }
  }
  return { tenantsScanned: tenants.length, proposalsCreated };
}

/**
 * Apply a human decision on a guardrail proposal.
 *
 * - `approved` → invokes the injected `pause` callback (the real ad-platform
 *   mutation) and marks the proposal approved.
 * - `rejected` → no external side effect.
 *
 * The pause action is injected so this package never touches a platform API
 * directly.
 */
export async function decideGuardrailProposal(
  proposal: Proposal,
  action: "approved" | "rejected",
  deps: {
    pause: (proposal: Proposal) => Promise<void>;
    logger?: GuardrailLogger;
  },
): Promise<{ ok: boolean; action: "approved" | "rejected"; paused: boolean }> {
  if (action === "approved") {
    await deps.pause(proposal);
    return { ok: true, action, paused: true };
  }
  return { ok: true, action, paused: false };
}
