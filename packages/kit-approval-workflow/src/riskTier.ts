/**
 * 3-tier Risk Classifier for agent/user actions.
 *
 * Ported verbatim from 実運用SaaS server/services/riskTier.ts, with the
 * product-specific action-type names extracted into an injectable config
 * (defaults preserve the original behaviour exactly).
 */

export interface AgentAction {
  type: string;
  estimatedSpend: number;
}

export type RiskTier = "low" | "medium" | "high";

export interface RiskTierConfig {
  /** Non-destructive, no/low cost — automatic execution allowed. */
  lowRiskTypes: readonly string[];
  /** Always high risk regardless of spend. */
  highRiskTypes: readonly string[];
  /** Spend at or above this is high risk. */
  highSpendThreshold: number;
  /** Medium risk when below the spend threshold. */
  mediumRiskTypes: readonly string[];
}

export const DEFAULT_RISK_TIER_CONFIG: RiskTierConfig = {
  lowRiskTypes: ["draft-save", "analytics-refresh"],
  highRiskTypes: ["ad-budget-change"],
  highSpendThreshold: 1000,
  mediumRiskTypes: ["publish"],
};

/**
 * Classifies an action into one of three risk tiers.
 *
 * - Low: Automatic execution allowed.
 * - Medium: Single human approver (e.g. via Slack).
 * - High: Multi-approver mandatory.
 */
export function classifyRisk(
  action: AgentAction,
  config: RiskTierConfig = DEFAULT_RISK_TIER_CONFIG,
): RiskTier {
  // 1. Low risk: non-destructive, no/low cost
  if (config.lowRiskTypes.includes(action.type)) {
    return "low";
  }

  // 2. High risk: budget changes or high cost
  if (
    config.highRiskTypes.includes(action.type) ||
    action.estimatedSpend >= config.highSpendThreshold
  ) {
    return "high";
  }

  // 3. Medium risk: publishing content with low cost
  if (
    config.mediumRiskTypes.includes(action.type) &&
    action.estimatedSpend < config.highSpendThreshold
  ) {
    return "medium";
  }

  return "medium"; // safe default
}
