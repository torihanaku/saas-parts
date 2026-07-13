/**
 * Injected persistence surface for the A/B testing service.
 *
 * The original 実運用SaaS implementation talked to Supabase directly.
 * Here all persistence is abstracted behind `AbTestingStore` so the service is
 * self-contained and backend-agnostic. Adapters (Supabase, Postgres, in-memory)
 * implement this interface.
 */

import type {
  Experiment,
  Variant,
  ExperimentSurface,
  VariantPayload,
  VariantSource,
  OutcomeEventType,
} from "./types.js";

/** Row to persist when creating an experiment. */
export interface CreateExperimentRow {
  tenantId: string;
  createdBy: string | null;
  name: string;
  description: string | null;
  surface: Experiment["surface"];
  algorithm: Experiment["algorithm"];
  targetMetric: string;
  segmentFilter: Experiment["segmentFilter"];
  config: Experiment["config"];
}

/** Row to persist for a single variant. */
export interface CreateVariantRow {
  experimentId: string;
  tenantId: string;
  label: string;
  isControl: boolean;
  payload: VariantPayload;
  source: VariantSource;
}

/** Outcome to append. */
export interface OutcomeRow {
  experimentId: string;
  variantId: string;
  tenantId: string;
  subjectId: string | null;
  segment: string | null;
  eventType: OutcomeEventType;
  reward: number;
  metadata: Record<string, unknown>;
}

/** Posterior patch applied to a variant after an outcome. */
export interface VariantPosteriorPatch {
  alphaDelta: number;
  betaDelta: number;
  impressionsDelta: number;
  conversionsDelta: number;
}

/** Minimal posterior view of a variant (allocate / determineWinner). */
export interface VariantPosterior {
  id: string;
  alpha: number;
  beta: number;
  impressions: number;
}

export interface AbTestingStore {
  createExperiment(row: CreateExperimentRow): Promise<Experiment>;
  /** Surface for a given experiment, or null when not found for the tenant. */
  getExperimentSurface(
    experimentId: string,
    tenantId: string,
  ): Promise<ExperimentSurface | null>;
  insertVariants(rows: CreateVariantRow[]): Promise<Variant[]>;
  listVariantPosteriors(
    experimentId: string,
    tenantId: string,
  ): Promise<VariantPosterior[]>;
  appendOutcome(row: OutcomeRow): Promise<void>;
  applyVariantPosteriorPatch(
    variantId: string,
    patch: VariantPosteriorPatch,
  ): Promise<void>;
  markWinner(input: {
    experimentId: string;
    tenantId: string;
    winnerVariantId: string;
    decidedAt: string;
  }): Promise<void>;
  listExperiments(tenantId: string): Promise<Experiment[]>;
  getVariants(experimentId: string, tenantId: string): Promise<Variant[]>;
}
