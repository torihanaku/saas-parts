/**
 * AI Native A/B Testing — service layer (ported from 実運用SaaS #362).
 *
 * Experiment lifecycle orchestration: create → AI variant generation → measure
 * → winner decision → end. Persistence, bandit allocation, and significance
 * testing are all injected (see `AbTestingStore`, `Allocator`,
 * `SignificanceTester`) so this module stays self-contained.
 */

import type {
  Experiment,
  Variant,
  AllocationResult,
  WinnerDecision,
  ExperimentSurface,
  BanditAlgorithm,
  Segment,
  VariantPayload,
  OutcomeEventType,
  Allocator,
  SignificanceTester,
} from "./types.js";
import type { AbTestingStore } from "./store.js";

export const DEFAULT_WINNER_THRESHOLD = 0.95;
export const DEFAULT_MIN_SAMPLES = 200;
export const DEFAULT_EXPLORATION_FLOOR = 0.05;

export interface CreateExperimentInput {
  tenantId: string;
  createdBy?: string | null;
  name: string;
  description?: string;
  surface: ExperimentSurface;
  algorithm?: BanditAlgorithm;
  targetMetric: string;
  segmentFilter?: Segment[];
  config?: Experiment["config"];
}

export interface VariantSeed {
  label: string;
  payload: VariantPayload;
  isControl?: boolean;
  source?: Variant["source"];
}

export interface VariantGenerator {
  (input: {
    surface: ExperimentSurface;
    brandVoice?: string;
    count: number;
  }): Promise<VariantSeed[]>;
}

/** Injected dependencies for the service. */
export interface AbTestingDeps {
  store: AbTestingStore;
  allocator: Allocator;
  significance: SignificanceTester;
}

/**
 * The A/B testing service. Construct once with injected deps, then call the
 * lifecycle methods.
 */
export class AbTestingService {
  constructor(private readonly deps: AbTestingDeps) {}

  async createExperiment(input: CreateExperimentInput): Promise<Experiment> {
    if (!input.name?.trim()) throw new Error("name is required");
    if (!input.targetMetric?.trim()) throw new Error("targetMetric is required");
    return this.deps.store.createExperiment({
      tenantId: input.tenantId,
      createdBy: input.createdBy ?? null,
      name: input.name.trim(),
      description: input.description ?? null,
      surface: input.surface,
      algorithm: input.algorithm ?? "thompson",
      targetMetric: input.targetMetric.trim(),
      segmentFilter: input.segmentFilter ?? [],
      config: input.config ?? {},
    });
  }

  async generateVariants(
    experimentId: string,
    tenantId: string,
    count: number,
    generator: VariantGenerator,
    brandVoice?: string,
  ): Promise<Variant[]> {
    const safeCount = Math.max(2, Math.min(50, Math.floor(count)));
    const surface = await this.deps.store.getExperimentSurface(
      experimentId,
      tenantId,
    );
    if (!surface) throw new Error(`experiment not found: ${experimentId}`);
    const seeds = await generator({ surface, brandVoice, count: safeCount });
    if (seeds.length === 0) throw new Error("generator returned 0 variants");
    const rows = seeds.map((s) => ({
      experimentId,
      tenantId,
      label: s.label,
      isControl: s.isControl ?? false,
      payload: s.payload,
      source: s.source ?? ("ai" as const),
    }));
    return this.deps.store.insertVariants(rows);
  }

  async allocate(
    experimentId: string,
    tenantId: string,
    rand: () => number = Math.random,
  ): Promise<AllocationResult> {
    const posteriors = await this.deps.store.listVariantPosteriors(
      experimentId,
      tenantId,
    );
    if (posteriors.length === 0) {
      throw new Error(`allocate: no variants for ${experimentId}`);
    }
    const variants = posteriors.map((d) => ({
      id: d.id,
      alpha: d.alpha,
      beta: d.beta,
    }));
    // Exploration floor: probability `floor` ⇒ uniform; else Thompson.
    if (rand() < DEFAULT_EXPLORATION_FLOOR) {
      return this.deps.allocator.uniformAllocate(variants, rand);
    }
    return this.deps.allocator.thompsonAllocate(variants, rand);
  }

  async recordOutcome(input: {
    experimentId: string;
    variantId: string;
    tenantId: string;
    eventType: OutcomeEventType;
    reward?: number;
    subjectId?: string;
    segment?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const reward =
      input.reward ?? (input.eventType === "conversion" ? 1 : 0);
    await this.deps.store.appendOutcome({
      experimentId: input.experimentId,
      variantId: input.variantId,
      tenantId: input.tenantId,
      subjectId: input.subjectId ?? null,
      segment: input.segment ?? null,
      eventType: input.eventType,
      reward,
      metadata: input.metadata ?? {},
    });
    // Update aggregate posterior. Beta(α, β): success ⇒ α+=1, fail ⇒ β+=1.
    const isSuccess =
      input.eventType === "conversion" ||
      (input.eventType === "revenue" && reward > 0);
    await this.deps.store.applyVariantPosteriorPatch(input.variantId, {
      alphaDelta: isSuccess ? 1 : 0,
      betaDelta: isSuccess ? 0 : 1,
      impressionsDelta: 1,
      conversionsDelta: isSuccess ? 1 : 0,
    });
  }

  async determineWinner(
    experimentId: string,
    tenantId: string,
    threshold: number = DEFAULT_WINNER_THRESHOLD,
    minSamples: number = DEFAULT_MIN_SAMPLES,
  ): Promise<WinnerDecision> {
    const posteriors = await this.deps.store.listVariantPosteriors(
      experimentId,
      tenantId,
    );
    if (posteriors.length < 2) {
      return notDecided(experimentId, "insufficient_variants");
    }

    // Dual-criterion winner — both rules must agree.
    //   Rule 1: Bayesian credible-interval dominance (significance).
    //   Rule 2: posteriorBestProbability >= threshold (MC check).
    const significance = this.deps.significance(posteriors, minSamples);
    if (significance.status === "insufficient_samples") {
      return notDecided(experimentId, significance.reason);
    }
    if (significance.status === "still_running") {
      return notDecided(experimentId, significance.reason);
    }

    const winnerId = significance.winnerId!;
    const prob = this.deps.allocator.posteriorBestProbability(
      posteriors.map((d) => ({ id: d.id, alpha: d.alpha, beta: d.beta })),
      winnerId,
    );
    if (prob < threshold) {
      return {
        experimentId,
        winnerVariantId: null,
        posteriorProbability: prob,
        rationale: "posterior_below_threshold",
        decidedAt: null,
      };
    }
    const decidedAt = new Date().toISOString();
    await this.deps.store.markWinner({
      experimentId,
      tenantId,
      winnerVariantId: winnerId,
      decidedAt,
    });
    return {
      experimentId,
      winnerVariantId: winnerId,
      posteriorProbability: prob,
      rationale: "winner_declared",
      decidedAt,
    };
  }

  listExperiments(tenantId: string): Promise<Experiment[]> {
    return this.deps.store.listExperiments(tenantId);
  }

  getVariants(experimentId: string, tenantId: string): Promise<Variant[]> {
    return this.deps.store.getVariants(experimentId, tenantId);
  }
}

function notDecided(experimentId: string, rationale: string): WinnerDecision {
  return {
    experimentId,
    winnerVariantId: null,
    posteriorProbability: 0,
    rationale,
    decidedAt: null,
  };
}

export const AB_TESTING_DEFAULTS = Object.freeze({
  WINNER_THRESHOLD: DEFAULT_WINNER_THRESHOLD,
  MIN_SAMPLES: DEFAULT_MIN_SAMPLES,
  EXPLORATION_FLOOR: DEFAULT_EXPLORATION_FLOOR,
});
