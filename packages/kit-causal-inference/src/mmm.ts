import type {
  MmmChannelResult,
  MmmFitInput,
  MmmFitOutput,
  SaturationForm,
} from './mmm-types.js';
import { geometricAdstock } from './mmm-adstock.js';
import { saturate, saturationCurvePoints, saturationPoint } from './mmm-saturation.js';
import { bayesianFit, type ChannelParams } from './mmm-bayesian-fit.js';

/**
 * Top-level Media Mix Modeling (MMM) entry point.
 *
 * Ported from 実運用SaaS `server/lib/causal/mmm/index.ts`
 * (numerics unchanged).
 *
 * Pulls the per-channel adstock + saturation parameters out of the Bayesian
 * fit, computes downstream display quantities (contribution, ROI, saturation
 * curve, saturation point), and returns the same shape upstream consumers
 * need.
 *
 * Mirrors the input-validation philosophy of `runRdd` / `runDid`: shape
 * problems throw (caller translates to 422); model-quality issues are
 * surfaced via `warnings` and `assumptions` so the UI can show banners.
 */

const DEFAULT_SAMPLES = 500;
const DEFAULT_BURN_IN = 200;
const DEFAULT_SEED = 42;

export async function runMmm(input: MmmFitInput): Promise<MmmFitOutput> {
  validateInput(input);

  const saturationForm: SaturationForm = input.saturationForm ?? 'hill';
  const samples = input.samples ?? DEFAULT_SAMPLES;
  const burnIn = input.burnIn ?? DEFAULT_BURN_IN;
  const seed = input.seed ?? DEFAULT_SEED;

  const fit = bayesianFit(input.channels, input.y, {
    saturationForm,
    samples,
    burnIn,
    seed,
  });

  const warnings: string[] = [];
  const assumptions: Array<{ name: string; satisfied: boolean; note?: string }> = [];

  if (fit.acceptanceRate < 0.05) {
    warnings.push('mh_low_acceptance_rate');
  }
  if (fit.acceptanceRate > 0.7) {
    warnings.push('mh_high_acceptance_rate');
  }
  if (fit.rSquared < 0.3) {
    warnings.push('low_in_sample_fit');
  }

  assumptions.push({
    name: 'min_30_observations',
    satisfied: input.y.length >= 30,
    note: input.y.length < 30 ? `T=${input.y.length}` : undefined,
  });
  assumptions.push({
    name: 'positive_spend_per_channel',
    satisfied: input.channels.every((c) => c.spend.some((v) => v > 0)),
  });
  assumptions.push({
    name: 'no_perfect_collinearity',
    satisfied: true,
    note: 'OLS used Tikhonov ridge (1e-6); see mmm-bayesian-fit.ts',
  });

  const channels: MmmChannelResult[] = input.channels.map((ch, idx) =>
    summariseChannel(ch, idx, fit.bestState.channelParams[idx]!, saturationForm),
  );

  return {
    channels,
    intercept: fit.bestState.intercept,
    rSquared: fit.rSquared,
    samplesUsed: fit.samples.length,
    acceptanceRate: fit.acceptanceRate,
    saturationForm,
    warnings,
    assumptions,
  };
}

function summariseChannel(
  series: { channel: string; spend: number[] },
  _idx: number,
  params: ChannelParams,
  form: SaturationForm,
): MmmChannelResult {
  const adstocked = geometricAdstock(series.spend, params.lambda);
  const sat = saturate(adstocked, form, { shape: params.shape, scale: params.scale });
  const contribution = sat.reduce((s, v) => s + v * params.beta, 0);
  const totalSpend = series.spend.reduce((s, v) => s + Math.max(v, 0), 0);
  const roi = totalSpend > 0 ? contribution / totalSpend : null;
  const maxSpend = Math.max(...series.spend, 0);
  const curve = saturationCurvePoints(
    form,
    { shape: params.shape, scale: params.scale },
    maxSpend,
    params.beta,
  );
  return {
    channel: series.channel,
    adstockRate: params.lambda,
    saturationShape: params.shape,
    saturationScale: params.scale,
    beta: params.beta,
    contribution,
    roi,
    saturationPoint: saturationPoint(form, { shape: params.shape, scale: params.scale }),
    saturationCurve: curve,
  };
}

function validateInput(input: MmmFitInput): void {
  if (!Array.isArray(input.y) || input.y.length === 0) {
    throw new Error('runMmm: y must be a non-empty array');
  }
  if (!Array.isArray(input.channels) || input.channels.length === 0) {
    throw new Error('runMmm: channels must be a non-empty array');
  }
  for (const v of input.y) {
    if (!Number.isFinite(v)) {
      throw new Error('runMmm: y must contain finite numbers');
    }
  }
  for (const ch of input.channels) {
    if (!ch.channel || typeof ch.channel !== 'string') {
      throw new Error('runMmm: each channel must have a non-empty string name');
    }
    if (!Array.isArray(ch.spend) || ch.spend.length !== input.y.length) {
      throw new Error(
        `runMmm: channel '${ch.channel}' spend length (${ch.spend?.length ?? 0}) must match y length (${input.y.length})`,
      );
    }
    for (const v of ch.spend) {
      if (!Number.isFinite(v) || v < 0) {
        throw new Error(`runMmm: channel '${ch.channel}' spend must be finite and ≥ 0`);
      }
    }
  }
  // Identifiability guard: more than y.length / 4 channels is unlikely to be
  // estimable from a single time series. Fail loudly rather than producing a
  // garbage MAP estimate.
  if (input.channels.length > Math.max(2, Math.floor(input.y.length / 4))) {
    throw new Error(
      `runMmm: too many channels (${input.channels.length}) for y length (${input.y.length}); need ≥ 4 obs per channel`,
    );
  }
}

export type { MmmChannelResult, MmmFitInput, MmmFitOutput, SaturationForm };
