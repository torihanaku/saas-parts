/**
 * AI Bias Detection — shared types (frontend + backend).
 * Ported from dev-dashboard-v2 `shared/types/bias.ts` (Epic G10 MOAT, #356).
 * The detector uses the Claude v1 per-bias prompt set.
 */

/** Cognitive bias categories detected by the bias-detector service. */
export type BiasType =
  | "sunk_cost"
  | "confirmation"
  | "recency"
  | "bandwagon"
  | "anchoring"
  | "hippo";

/** Set of all bias types — convenient for validation / iteration. */
export const BIAS_TYPES: readonly BiasType[] = [
  "sunk_cost",
  "confirmation",
  "recency",
  "bandwagon",
  "anchoring",
  "hippo",
] as const;

/**
 * Decision-maker role labels passed into HiPPO bias weighting.
 * Higher-rank roles increase the prior probability that an unjustified
 * decision is HiPPO-driven.
 */
export type DecisionMakerRole =
  | "ceo"
  | "cmo"
  | "marketing_manager"
  | "analyst"
  | "other";

/**
 * Severity bucket derived from confidence. Used by the warning banner UI
 * and the auto-trigger Slack notifier.
 */
export type BiasSeverity = "low" | "high" | "critical";

/**
 * One detected bias signal. Persisted downstream by the trigger's store.
 * `evidence` is intentionally a free-form record.
 */
export interface BiasDetection {
  id: string;
  tenantId: string;
  decisionId: string | null;
  biasType: BiasType;
  /** Detection confidence in [0, 1]. */
  confidence: number;
  evidence: Record<string, unknown>;
  recommendation: string | null;
  detectedAt: string;
  /** Detector implementation tag. "claude-v1" for the per-bias prompt set. */
  detectorVersion?: string;
  /** Role of the decision-maker, if known. Drives HiPPO weighting. */
  decisionMakerRole?: DecisionMakerRole | null;
}

/**
 * Input passed to BiasDetectorService.detectBiases().
 * Mirrors the minimum context an AI analyzer needs to spot bias on a decision.
 */
export interface DecisionContext {
  decisionId?: string;
  subject: string;
  reason: string;
  context?: string;
  alternativesConsidered?: string | null;
  /** Optional historical signals (prior spend, success/failure ratio, etc.). */
  history?: Record<string, unknown>;
  /**
   * Role label of the person making this decision. Increases the HiPPO
   * detector's sensitivity when the role is C-level and the reason is thin.
   */
  decisionMakerRole?: DecisionMakerRole | null;
}

/** Critical-bias threshold used by both the auto-trigger and the UI banner. */
export const BIAS_CRITICAL_THRESHOLD = 0.7;
/** High-severity threshold (between low and critical). */
export const BIAS_HIGH_THRESHOLD = 0.55;

/** Map a confidence number to a UI severity bucket. */
export function biasSeverity(confidence: number): BiasSeverity {
  if (confidence >= BIAS_CRITICAL_THRESHOLD) return "critical";
  if (confidence >= BIAS_HIGH_THRESHOLD) return "high";
  return "low";
}

// ─── Injected dependencies ───────────────────────────────────────────────────

/**
 * Injected LLM surface. Production wires this to a Claude client
 * (e.g. `generateJson` from an api client). The system prompt must instruct
 * the model to return valid JSON; the implementation must return `fallback`
 * on any error and never throw.
 */
export interface BiasLlmClient {
  generateJson<T>(
    system: string,
    userPrompt: string,
    fallback: T,
    options?: { maxTokens?: number; timeout?: number },
  ): Promise<T>;
}
