/**
 * Types for Media Mix Modeling (MMM).
 *
 * Ported from 実運用SaaS `shared/types/causal-mmm.ts` (the Supabase
 * row type `MmmResultRow` was dropped — persistence is the caller's concern).
 *
 * MMM estimates each marketing channel's contribution to outcomes (revenue /
 * conversions) by fitting an adstock + saturation transformation per channel
 * and a linear combination over channels. Bayesian fit is approximated with
 * a lightweight grid + Metropolis-Hastings refinement, all in pure TS.
 */

/** Functional form for the diminishing-returns curve on a single channel. */
export type SaturationForm = 'hill' | 'weibull';

/**
 * One channel's daily input series. The MMM fit only consumes `spend`;
 * impressions/conversions are kept for downstream UI display and never used
 * in the regression.
 */
export interface MmmChannelSeries {
  channel: string;
  /** Length-T spend series in the model's chosen currency / unit. */
  spend: number[];
  /** Optional metadata (display only). */
  impressions?: number[];
  conversions?: number[];
}

export interface MmmFitInput {
  tenantId?: string;
  experimentId?: string;
  /** Length-T outcome series (revenue, conversions, etc). */
  y: number[];
  channels: MmmChannelSeries[];
  /** Hill (default) or Weibull saturation. */
  saturationForm?: SaturationForm;
  /** Number of MH samples kept after burn-in (default 500). */
  samples?: number;
  /** Number of MH burn-in steps (default 200). */
  burnIn?: number;
  /** Random seed for reproducibility (default 42). */
  seed?: number;
  /** Confidence level for credible intervals (default 0.95). */
  confidenceLevel?: number;
}

export interface MmmChannelResult {
  channel: string;
  /**
   * Adstock decay rate (geometric). 0 = no carry-over, 0.99 = very long tail.
   */
  adstockRate: number;
  /** Saturation exponent (Hill: kappa) or shape (Weibull: k). */
  saturationShape: number;
  /** Saturation half-saturation point (Hill: K) or scale (Weibull: λ). */
  saturationScale: number;
  /** Linear coefficient on the transformed series. */
  beta: number;
  /** Estimated total contribution to y (sum over the period). */
  contribution: number;
  /** ROI = contribution / total spend (NaN-safe; null when spend == 0). */
  roi: number | null;
  /** Spend at which marginal return falls below 50% of peak. */
  saturationPoint: number;
  /**
   * Curve points for UI: spend levels × predicted contribution. Up to 50
   * points sampled across the observed spend range plus 30% headroom.
   */
  saturationCurve: Array<{ spend: number; contribution: number }>;
}

export interface MmmFitOutput {
  /** Per-channel posterior summaries. */
  channels: MmmChannelResult[];
  /** Intercept term (baseline outcome). */
  intercept: number;
  /** R^2 of the in-sample fit (0..1). */
  rSquared: number;
  /** Number of MH samples used for the posterior summary. */
  samplesUsed: number;
  /** Acceptance rate of the MH sampler (diagnostic). */
  acceptanceRate: number;
  saturationForm: SaturationForm;
  warnings: string[];
  assumptions: Array<{ name: string; satisfied: boolean; note?: string }>;
}
