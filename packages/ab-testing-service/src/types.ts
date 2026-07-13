/**
 * AI Native A/B Testing — shared types (ported from 実運用SaaS #362).
 *
 * Bandit posterior is encoded as Beta(alpha, beta) per variant so Thompson
 * sampling stays stateless. Outcomes are append-only; aggregations are
 * denormalized onto Variant for cheap dashboard reads.
 */

export type ExperimentStatus =
  | "draft"
  | "running"
  | "paused"
  | "completed"
  | "archived";

export type ExperimentSurface =
  | "email_subject"
  | "cta_text"
  | "lp_copy"
  | "banner_creative"
  | "other";

export type BanditAlgorithm = "thompson" | "epsilon_greedy" | "ucb" | "fixed";

export type VariantSource = "ai" | "human" | "fallback";

export type OutcomeEventType = "impression" | "conversion" | "revenue";

export interface Segment {
  /** ISO key e.g. "tier:enterprise" or "country:JP". Free-form. */
  key: string;
  value: string;
}

export interface VariantPayload {
  headline?: string;
  subject?: string;
  body?: string;
  cta?: string;
  imageUrl?: string;
  /** Surface-specific fields go here without further migrations. */
  [k: string]: unknown;
}

export interface Variant {
  id: string;
  experimentId: string;
  tenantId: string;
  label: string;
  isControl: boolean;
  payload: VariantPayload;
  source: VariantSource;
  /** Beta posterior parameter alpha (success-like). */
  alpha: number;
  /** Beta posterior parameter beta (failure-like). */
  beta: number;
  impressions: number;
  conversions: number;
  /** Last computed allocation weight (0..1). Recomputed on each allocate(). */
  allocationWeight: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentConfig {
  explorationFloor?: number;
  minSamplesPerVariant?: number;
  winnerThreshold?: number;
  brandVoice?: string;
}

export interface Experiment {
  id: string;
  tenantId: string;
  createdBy: string | null;
  name: string;
  description: string | null;
  surface: ExperimentSurface;
  status: ExperimentStatus;
  algorithm: BanditAlgorithm;
  targetMetric: string;
  segmentFilter: Segment[];
  config: ExperimentConfig;
  winnerVariantId: string | null;
  winnerDecidedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Outcome {
  id: string;
  experimentId: string;
  variantId: string;
  tenantId: string;
  subjectId: string | null;
  segment: string | null;
  eventType: OutcomeEventType;
  reward: number;
  metadata: Record<string, unknown>;
  observedAt: string;
}

export interface AllocationResult {
  variantId: string;
  source: "thompson" | "epsilon_greedy" | "ucb" | "fixed" | "fallback";
  /** Probability mass assigned to the chosen variant at decision time. */
  probability: number;
}

export interface WinnerDecision {
  experimentId: string;
  winnerVariantId: string | null;
  /** Posterior probability that the winner beats every other variant. */
  posteriorProbability: number;
  /** Reason the decision was (or was not) made. */
  rationale: string;
  decidedAt: string | null;
}

// ─── Injected math interfaces ────────────────────────────────────────────────
// These minimal, local interfaces keep the service decoupled from any concrete
// bandit / significance implementation. `@torihanaku/thompson-bandit` and
// `@torihanaku/ab-significance` satisfy them (see README) but are NOT imported.

/** Posterior for a single variant, used by the significance tester. */
export interface BetaPosterior {
  id: string;
  alpha: number;
  beta: number;
  impressions: number;
}

/** Result shape a `SignificanceTester` returns. */
export interface SignificanceResult {
  status: "winner" | "still_running" | "insufficient_samples";
  winnerId: string | null;
  intervals: Array<{ id: string; mean: number; ciLower: number; ciUpper: number }>;
  reason: string;
}

/**
 * Injected significance decision. Satisfied by
 * `@torihanaku/ab-significance`'s `decideSignificance`.
 */
export type SignificanceTester = (
  variants: BetaPosterior[],
  minSamples: number,
) => SignificanceResult;

/** A variant's posterior params, used by the allocator. */
export interface AllocatorVariant {
  id: string;
  alpha: number;
  beta: number;
}

/**
 * Injected bandit allocation surface. Satisfied by
 * `@torihanaku/thompson-bandit` (`thompsonAllocate` / `uniformAllocate` /
 * `posteriorBestProbability`).
 */
export interface Allocator {
  thompsonAllocate(
    variants: AllocatorVariant[],
    rand: () => number,
  ): AllocationResult;
  uniformAllocate(
    variants: AllocatorVariant[],
    rand: () => number,
  ): AllocationResult;
  posteriorBestProbability(
    variants: AllocatorVariant[],
    candidateId: string,
    rand?: () => number,
  ): number;
}
