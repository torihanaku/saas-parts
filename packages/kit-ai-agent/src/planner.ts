/**
 * Plan Agent: generates a period plan (objective + actions) via an injected
 * LLM caller, persists it as `pending_approval`, and supports natural-language
 * feedback regeneration ("Learning Loop").
 *
 * 出典: 実運用SaaS server/services/agentPlanner.ts
 * 変更点: Supabase 直結 → PlanStore 注入 / ANTHROPIC_API_KEY・BYOK 解決 →
 *         LlmCaller 注入 / マーケ固有プロンプト → PlannerPrompts 設定に外出し。
 */
import type { LlmCaller } from "./llm";
import type { AgentPlan, PlanActionInput, PlanStore, RiskLevel } from "./types";

export interface RawPlan {
  objective: string;
  actions: PlanActionInput[];
}

export interface PlannerPrompts {
  /** System prompt for initial plan generation. */
  system: string;
  /** System prompt for feedback-driven revision (defaults to `system`). */
  reviseSystem?: string;
  /** Builds the user prompt for a new plan. `learningContext` is "" when no history. */
  buildGeneratePrompt(params: { tenantId: string; learningContext: string }): string;
  /** Builds the user prompt for a revision. */
  buildRevisePrompt(params: {
    plan: AgentPlan;
    actions: PlanActionInput[];
    feedback: string;
    learningContext: string;
  }): string;
}

/** Provider-neutral default prompts (元実装のマーケ専用文言は落とし、形だけ保持). */
export const DEFAULT_PROMPTS: PlannerPrompts = {
  system:
    "You are a professional planner. Generate a structured plan with 3-5 specific actions. " +
    "When prior reports are provided, explicitly reference what worked, what didn't, and how the next plan responds.",
  buildGeneratePrompt: ({ tenantId, learningContext }) => {
    const learningBlock = learningContext
      ? `## Learnings from prior cycles (Plan → Deploy → Monitor → Learn)\n${learningContext}\n\n---\n\n`
      : "";
    return (
      `${learningBlock}Generate a plan for tenant ${tenantId} for the next period.\n` +
      `Provide result as JSON: { objective: string, actions: Array<{ title, description, action_type, risk_level, approval_required }> }`
    );
  },
  buildRevisePrompt: ({ plan, actions, feedback, learningContext }) => {
    const learningBlock = learningContext
      ? `## Learnings from prior cycles\n${learningContext}\n\n---\n\n`
      : "";
    return (
      `${learningBlock}Current Plan Objective: ${plan.objective}\n` +
      `Current Actions: ${JSON.stringify(actions)}\n` +
      `Feedback: ${feedback}\n\n` +
      `Revise the plan and return as JSON: { objective: string, actions: Array<{ title, description, action_type, risk_level, approval_required }> }`
    );
  },
};

/** Decision log hook (元: dd_decision_log insert)。省略時は記録しない。 */
export type DecisionLogger = (entry: {
  tenantId: string;
  decisionType: string;
  subject: string;
  context: string;
  reason: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}) => Promise<void> | void;

export interface PlannerConfig {
  llm: LlmCaller;
  store: PlanStore;
  prompts?: PlannerPrompts;
  /**
   * Learning-loop context provider (元: 直近4週の weekly report を markdown 化)。
   * 返り値 "" = 履歴なし。省略時は常に ""。
   */
  loadLearningContext?: (tenantId: string) => Promise<string>;
  /** Period key generator (元: ISO week)。デフォルトは currentIsoWeek。 */
  planPeriod?: () => string;
  /** Fallback plan when the LLM returns unparseable output. */
  fallbackPlan?: RawPlan;
  decisionLog?: DecisionLogger;
}

/** ISO week string (e.g. "2026-W28") in UTC. 出典: routes/agent/get-handlers.ts */
export function currentIsoWeek(date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const DEFAULT_FALLBACK: RawPlan = {
  objective: "Increase engagement",
  actions: [
    {
      title: "Draft update",
      description: "Prepare a short update for the main channel",
      action_type: "draft",
      risk_level: "low",
      approval_required: "none",
    },
  ],
};

function normalizeAction(a: PlanActionInput): PlanActionInput {
  const riskLevels: RiskLevel[] = ["low", "medium", "high", "critical"];
  return {
    ...a,
    risk_level: riskLevels.includes(a.risk_level) ? a.risk_level : "high",
    approval_required: a.approval_required ?? "none",
  };
}

export interface PlanWithActions {
  plan: AgentPlan;
  actions: PlanActionInput[];
}

export interface Planner {
  generatePlan(tenantId: string): Promise<PlanWithActions>;
  regenerateWithFeedback(params: {
    tenantId: string;
    planId: string;
    feedback: string;
  }): Promise<PlanWithActions>;
}

export function createPlanner(config: PlannerConfig): Planner {
  const prompts = config.prompts ?? DEFAULT_PROMPTS;
  const fallback = config.fallbackPlan ?? DEFAULT_FALLBACK;
  const planPeriod = config.planPeriod ?? currentIsoWeek;
  const loadContext = config.loadLearningContext ?? (async () => "");

  async function persistPlan(
    tenantId: string,
    period: string,
    raw: RawPlan,
    metadata?: Record<string, unknown>,
  ): Promise<PlanWithActions> {
    const actions = raw.actions.map(normalizeAction);
    const plan = await config.store.insertPlan({
      tenant_id: tenantId,
      plan_period: period,
      objective: raw.objective,
      status: "pending_approval",
      ...(metadata ? { metadata } : {}),
    });
    await config.store.insertActions(
      actions.map((a) => ({
        ...a,
        tenant_id: tenantId,
        plan_id: plan.id,
        status: "pending_approval" as const,
      })),
    );
    return { plan, actions };
  }

  return {
    async generatePlan(tenantId) {
      const learningContext = await loadContext(tenantId);
      const raw = await config.llm.generateJson<RawPlan>(
        prompts.system,
        prompts.buildGeneratePrompt({ tenantId, learningContext }),
        fallback,
      );
      return persistPlan(tenantId, planPeriod(), raw);
    },

    async regenerateWithFeedback({ tenantId, planId, feedback }) {
      const oldPlan = await config.store.getPlan(planId);
      if (!oldPlan) throw new Error("plan_not_found");
      const oldActions = await config.store.listActionsByPlan(planId);

      const learningContext = await loadContext(tenantId);
      const raw = await config.llm.generateJson<RawPlan>(
        prompts.reviseSystem ?? prompts.system,
        prompts.buildRevisePrompt({
          plan: oldPlan,
          actions: oldActions,
          feedback,
          learningContext,
        }),
        { objective: oldPlan.objective, actions: oldActions },
      );

      // Mark old plan revised, insert the new one linked back to it.
      await config.store.updatePlan(planId, { status: "revised" });
      const result = await persistPlan(tenantId, oldPlan.plan_period, raw, {
        revised_from: planId,
        feedback,
      });

      await config.decisionLog?.({
        tenantId,
        decisionType: "change",
        subject: `Plan Revised: ${result.plan.id}`,
        context: `User provided feedback for plan ${planId}`,
        reason: feedback,
        resourceType: "agent_plan",
        resourceId: result.plan.id,
        metadata: { method: "plan_feedback_loop", original_plan_id: planId },
      });

      return result;
    },
  };
}
