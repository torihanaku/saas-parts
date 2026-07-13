import type { MmmChannelSeries, SaturationForm } from './mmm-types.js';
import { mean } from './stats.js';
import { ADSTOCK_GRID, geometricAdstock } from './mmm-adstock.js';
import {
  SHAPE_GRID_HILL,
  SHAPE_GRID_WEIBULL,
  saturate,
} from './mmm-saturation.js';

/**
 * Lightweight Bayesian fit for the MMM regression coefficients.
 *
 * Ported from 実運用SaaS `server/lib/causal/mmm/bayesian-fit.ts`
 * (numerics unchanged).
 *
 * For each channel we estimate (lambda, shape, scale, beta). Doing a full
 * NUTS sampler in pure TS is impractical, so we use a two-stage approach:
 *
 *   1. Coarse **grid search** over (lambda, shape, scale) using priors
 *      `ADSTOCK_GRID`, `SHAPE_GRID_*`, and a scale grid derived from the
 *      observed spend range. For each grid point we close-form solve for
 *      beta and intercept by OLS over the transformed inputs.
 *
 *   2. **Metropolis-Hastings refinement** around the grid optimum. Each MH
 *      step proposes a small Gaussian perturbation of (lambda, shape, scale)
 *      per channel, recomputes the OLS beta, and accepts/rejects based on
 *      Gaussian likelihood with σ from the residual std.
 *
 * This converges quickly (~1s for 8 channels × 365 days) and gives usable
 * posterior summaries without bringing in PyMC. Returned `samples` are the
 * post-burn-in MH samples used for credible intervals upstream.
 */

export interface ChannelParams {
  lambda: number;
  shape: number;
  scale: number;
  beta: number;
}

export interface FitState {
  intercept: number;
  channelParams: ChannelParams[];
}

export interface FitOutput {
  bestState: FitState;
  samples: FitState[];
  acceptanceRate: number;
  rSquared: number;
  residualStd: number;
}

interface FitOptions {
  saturationForm: SaturationForm;
  samples: number;
  burnIn: number;
  seed: number;
}

/**
 * Deterministic LCG so tests are reproducible across machines without depending
 * on Math.random's runtime-specific seeding.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Box–Muller transform on the LCG output for Gaussian proposals. */
function gaussian(rng: () => number, mu = 0, sigma = 1): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mu + sigma * z;
}

/**
 * Closed-form OLS: given the transformed channel matrix X (T × C) and target
 * y (T), solve for (intercept, betas) using the normal equations on
 * X̃ = [1 | X]. We do this with a small Gauss-Jordan over the (C+1)×(C+1)
 * Gram matrix; channels (C) is small (≤ 8) so cubic cost is fine.
 */
function olsFit(X: number[][], y: number[]): { intercept: number; betas: number[]; rss: number } {
  const T = y.length;
  const C = X[0]?.length ?? 0;
  const P = C + 1;
  const A: number[][] = Array.from({ length: P }, () => new Array(P).fill(0));
  const b: number[] = new Array(P).fill(0);
  for (let t = 0; t < T; t++) {
    const row = [1, ...X[t]!];
    for (let i = 0; i < P; i++) {
      b[i]! += row[i]! * y[t]!;
      for (let j = 0; j < P; j++) A[i]![j]! += row[i]! * row[j]!;
    }
  }
  // Tikhonov ridge (1e-6) for numerical stability when channels collinear.
  for (let i = 0; i < P; i++) A[i]![i]! += 1e-6;
  const sol = solveLinearSystem(A, b);
  let rss = 0;
  for (let t = 0; t < T; t++) {
    let yhat = sol[0]!;
    for (let c = 0; c < C; c++) yhat += sol[c + 1]! * X[t]![c]!;
    rss += (y[t]! - yhat) ** 2;
  }
  return { intercept: sol[0]!, betas: sol.slice(1), rss };
}

/** Gauss-Jordan elimination on an n×n system Ax = b. Returns x. */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M: number[][] = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    // Partial pivoting.
    let pivotRow = col;
    let pivotVal = Math.abs(M[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > pivotVal) {
        pivotVal = Math.abs(M[r]![col]!);
        pivotRow = r;
      }
    }
    if (pivotVal < 1e-12) {
      throw new Error('solveLinearSystem: singular matrix (channels too collinear)');
    }
    if (pivotRow !== col) [M[col], M[pivotRow]] = [M[pivotRow]!, M[col]!];
    const pivot = M[col]![col]!;
    for (let j = col; j <= n; j++) M[col]![j]! /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r]![col]!;
      if (factor === 0) continue;
      for (let j = col; j <= n; j++) M[r]![j]! -= factor * M[col]![j]!;
    }
  }
  return M.map((row) => row[n]!);
}

function transformChannels(
  channels: MmmChannelSeries[],
  params: ChannelParams[],
  form: SaturationForm,
): number[][] {
  const T = channels[0]?.spend.length ?? 0;
  const out: number[][] = Array.from({ length: T }, () => new Array(channels.length).fill(0));
  for (let c = 0; c < channels.length; c++) {
    const adstocked = geometricAdstock(channels[c]!.spend, params[c]!.lambda);
    const sat = saturate(adstocked, form, {
      shape: params[c]!.shape,
      scale: params[c]!.scale,
    });
    for (let t = 0; t < T; t++) out[t]![c] = sat[t]!;
  }
  return out;
}

function scaleGrid(spend: number[]): number[] {
  const max = Math.max(...spend, 1);
  return [max * 0.1, max * 0.25, max * 0.5, max * 1.0, max * 2.0];
}

/**
 * Stage 1: independent per-channel grid search. We hold all other channels at
 * "neutral" (lambda=0, shape=1, scale=median spend) while sweeping the focal
 * channel's grid and minimising RSS. Cheap and gives a strong MH initialiser.
 */
function gridInitialise(
  channels: MmmChannelSeries[],
  y: number[],
  form: SaturationForm,
): FitState {
  const shapeGrid = form === 'hill' ? SHAPE_GRID_HILL : SHAPE_GRID_WEIBULL;
  const C = channels.length;
  const initParams: ChannelParams[] = channels.map((ch) => {
    const scales = scaleGrid(ch.spend);
    return { lambda: 0, shape: 1, scale: scales[Math.floor(scales.length / 2)]!, beta: 0 };
  });

  for (let c = 0; c < C; c++) {
    const scales = scaleGrid(channels[c]!.spend);
    let bestRss = Infinity;
    let best = initParams[c]!;
    for (const lam of ADSTOCK_GRID) {
      for (const sh of shapeGrid) {
        for (const sc of scales) {
          initParams[c] = { lambda: lam, shape: sh, scale: sc, beta: 0 };
          const X = transformChannels(channels, initParams, form);
          const { betas, rss } = olsFit(X, y);
          if (rss < bestRss) {
            bestRss = rss;
            best = { lambda: lam, shape: sh, scale: sc, beta: betas[c]! };
          }
        }
      }
    }
    initParams[c] = best;
  }

  const X = transformChannels(channels, initParams, form);
  const { intercept, betas } = olsFit(X, y);
  for (let c = 0; c < C; c++) initParams[c]!.beta = betas[c]!;
  return { intercept, channelParams: initParams };
}

/** MH proposal: small normal perturbation, projected back to valid bounds. */
function propose(state: FitState, rng: () => number): FitState {
  const next = state.channelParams.map((p) => {
    const lambda = clamp(p.lambda + gaussian(rng, 0, 0.05), 0, 0.95);
    const shape = clamp(p.shape + gaussian(rng, 0, 0.15), 0.2, 5.0);
    const scale = Math.max(p.scale * Math.exp(gaussian(rng, 0, 0.15)), 1e-6);
    return { lambda, shape, scale, beta: p.beta };
  });
  return { intercept: state.intercept, channelParams: next };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function logLikelihood(rss: number, T: number, sigma: number): number {
  const s2 = Math.max(sigma * sigma, 1e-12);
  return -0.5 * (rss / s2 + T * Math.log(2 * Math.PI * s2));
}

export function bayesianFit(
  channels: MmmChannelSeries[],
  y: number[],
  opts: FitOptions,
): FitOutput {
  const init = gridInitialise(channels, y, opts.saturationForm);
  const T = y.length;
  const yMean = mean(y);
  const tss = y.reduce((s, v) => s + (v - yMean) ** 2, 0);

  const X0 = transformChannels(channels, init.channelParams, opts.saturationForm);
  const fit0 = olsFit(X0, y);
  const sigma0 = Math.sqrt(fit0.rss / Math.max(T - channels.length - 1, 1));
  let current = { intercept: fit0.intercept, channelParams: init.channelParams };
  let currentRss = fit0.rss;
  let currentLL = logLikelihood(currentRss, T, sigma0);

  const rng = makeRng(opts.seed);
  const samples: FitState[] = [];
  let bestState = current;
  let bestRss = currentRss;
  let accepts = 0;
  const totalSteps = opts.burnIn + opts.samples;
  let sigma = sigma0;

  for (let step = 0; step < totalSteps; step++) {
    const proposed = propose(current, rng);
    let proposedRss: number;
    let proposedBetas: number[];
    let proposedIntercept: number;
    try {
      const Xp = transformChannels(channels, proposed.channelParams, opts.saturationForm);
      const fitP = olsFit(Xp, y);
      proposedRss = fitP.rss;
      proposedBetas = fitP.betas;
      proposedIntercept = fitP.intercept;
    } catch {
      continue; // singular matrix → reject silently
    }
    const proposedLL = logLikelihood(proposedRss, T, sigma);
    const logA = proposedLL - currentLL;
    if (Math.log(Math.max(rng(), 1e-12)) < logA) {
      for (let c = 0; c < proposed.channelParams.length; c++) {
        proposed.channelParams[c]!.beta = proposedBetas[c]!;
      }
      proposed.intercept = proposedIntercept;
      current = proposed;
      currentRss = proposedRss;
      currentLL = proposedLL;
      sigma = Math.sqrt(currentRss / Math.max(T - channels.length - 1, 1));
      accepts++;
      if (currentRss < bestRss) {
        bestRss = currentRss;
        bestState = current;
      }
    }
    if (step >= opts.burnIn) samples.push(current);
  }

  const rSquared = tss > 0 ? Math.max(0, 1 - bestRss / tss) : 0;
  return {
    bestState,
    samples,
    acceptanceRate: totalSteps > 0 ? accepts / totalSteps : 0,
    rSquared,
    residualStd: sigma,
  };
}
