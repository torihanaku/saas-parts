/**
 * Tests for ab-testing-service.ts (ported service-layer coverage from
 * 実運用SaaS tests/ab-testing.test.ts). Store / allocator / significance
 * are injected via in-memory fakes.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  AbTestingService,
  AB_TESTING_DEFAULTS,
  type AbTestingDeps,
} from "./ab-testing-service.js";
import type {
  AbTestingStore,
  CreateExperimentRow,
  CreateVariantRow,
  OutcomeRow,
  VariantPosterior,
  VariantPosteriorPatch,
} from "./store.js";
import type {
  Experiment,
  Variant,
  Allocator,
  SignificanceTester,
  AllocatorVariant,
} from "./types.js";

// ─── In-memory store ─────────────────────────────────────────────────────────

function makeStore() {
  let counter = 0;
  const uid = () => `id-${++counter}`;
  const experiments: Experiment[] = [];
  const variants: Variant[] = [];
  const outcomes: OutcomeRow[] = [];

  const store: AbTestingStore = {
    async createExperiment(row: CreateExperimentRow) {
      const now = new Date().toISOString();
      const exp: Experiment = {
        id: uid(),
        tenantId: row.tenantId,
        createdBy: row.createdBy,
        name: row.name,
        description: row.description,
        surface: row.surface,
        status: "draft",
        algorithm: row.algorithm,
        targetMetric: row.targetMetric,
        segmentFilter: row.segmentFilter,
        config: row.config,
        winnerVariantId: null,
        winnerDecidedAt: null,
        startedAt: null,
        endedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      experiments.push(exp);
      return exp;
    },
    async getExperimentSurface(experimentId, tenantId) {
      const e = experiments.find(
        (x) => x.id === experimentId && x.tenantId === tenantId,
      );
      return e ? e.surface : null;
    },
    async insertVariants(rows: CreateVariantRow[]) {
      const now = new Date().toISOString();
      const created = rows.map((r) => {
        const v: Variant = {
          id: uid(),
          experimentId: r.experimentId,
          tenantId: r.tenantId,
          label: r.label,
          isControl: r.isControl,
          payload: r.payload,
          source: r.source,
          alpha: 1,
          beta: 1,
          impressions: 0,
          conversions: 0,
          allocationWeight: 0,
          createdAt: now,
          updatedAt: now,
        };
        variants.push(v);
        return v;
      });
      return created;
    },
    async listVariantPosteriors(experimentId, tenantId): Promise<VariantPosterior[]> {
      return variants
        .filter((v) => v.experimentId === experimentId && v.tenantId === tenantId)
        .map((v) => ({
          id: v.id,
          alpha: v.alpha,
          beta: v.beta,
          impressions: v.impressions,
        }));
    },
    async appendOutcome(row: OutcomeRow) {
      outcomes.push(row);
    },
    async applyVariantPosteriorPatch(variantId, patch: VariantPosteriorPatch) {
      const v = variants.find((x) => x.id === variantId);
      if (!v) return;
      v.alpha += patch.alphaDelta;
      v.beta += patch.betaDelta;
      v.impressions += patch.impressionsDelta;
      v.conversions += patch.conversionsDelta;
    },
    async markWinner({ experimentId, tenantId, winnerVariantId, decidedAt }) {
      const e = experiments.find(
        (x) => x.id === experimentId && x.tenantId === tenantId,
      );
      if (!e) return;
      e.winnerVariantId = winnerVariantId;
      e.winnerDecidedAt = decidedAt;
      e.status = "completed";
    },
    async listExperiments(tenantId) {
      return experiments.filter((e) => e.tenantId === tenantId);
    },
    async getVariants(experimentId, tenantId) {
      return variants.filter(
        (v) => v.experimentId === experimentId && v.tenantId === tenantId,
      );
    },
  };
  return { store, experiments, variants, outcomes };
}

const stubAllocator: Allocator = {
  thompsonAllocate: (vs: AllocatorVariant[]) => ({
    variantId: vs[0]!.id,
    source: "thompson",
    probability: 1 / vs.length,
  }),
  uniformAllocate: (vs: AllocatorVariant[]) => ({
    variantId: vs[0]!.id,
    source: "epsilon_greedy",
    probability: 1 / vs.length,
  }),
  posteriorBestProbability: () => 0.99,
};

const winnerSignificance: SignificanceTester = (vs) => ({
  status: "winner",
  winnerId: vs[0]!.id,
  intervals: [],
  reason: "dominant",
});

function makeService(over?: Partial<AbTestingDeps>) {
  const { store, ...rest } = makeStore();
  const deps: AbTestingDeps = {
    store,
    allocator: stubAllocator,
    significance: winnerSignificance,
    ...over,
  };
  return { svc: new AbTestingService(deps), store, ...rest };
}

beforeEach(() => {});

describe("AB_TESTING_DEFAULTS", () => {
  it("exposes documented defaults", () => {
    expect(AB_TESTING_DEFAULTS.WINNER_THRESHOLD).toBe(0.95);
    expect(AB_TESTING_DEFAULTS.MIN_SAMPLES).toBe(200);
    expect(AB_TESTING_DEFAULTS.EXPLORATION_FLOOR).toBe(0.05);
  });
});

describe("createExperiment", () => {
  it("rejects empty name", async () => {
    const { svc } = makeService();
    await expect(
      svc.createExperiment({
        tenantId: "t1",
        name: "",
        surface: "email_subject",
        targetMetric: "ctr",
      }),
    ).rejects.toThrow(/name/);
  });

  it("rejects empty targetMetric", async () => {
    const { svc } = makeService();
    await expect(
      svc.createExperiment({
        tenantId: "t1",
        name: "x",
        surface: "email_subject",
        targetMetric: "  ",
      }),
    ).rejects.toThrow(/targetMetric/);
  });

  it("inserts and returns the persisted experiment", async () => {
    const { svc } = makeService();
    const exp = await svc.createExperiment({
      tenantId: "t1",
      name: "subject-line-test",
      surface: "email_subject",
      targetMetric: "open_rate",
      algorithm: "thompson",
    });
    expect(exp.id).toBeTruthy();
    expect(exp.name).toBe("subject-line-test");
    expect(exp.algorithm).toBe("thompson");
  });
});

describe("generateVariants", () => {
  it("rejects when experiment is missing", async () => {
    const { svc } = makeService();
    await expect(
      svc.generateVariants("missing", "t1", 3, async () => [
        { label: "a", payload: { headline: "h" } },
      ]),
    ).rejects.toThrow(/not found/);
  });

  it("rejects when generator returns 0 variants", async () => {
    const { svc } = makeService();
    const exp = await svc.createExperiment({
      tenantId: "t2",
      name: "n",
      surface: "cta_text",
      targetMetric: "ctr",
    });
    await expect(
      svc.generateVariants(exp.id, "t2", 3, async () => []),
    ).rejects.toThrow(/0 variants/);
  });

  it("clamps count to [2, 50]", async () => {
    const { svc } = makeService();
    const exp = await svc.createExperiment({
      tenantId: "t3",
      name: "n",
      surface: "cta_text",
      targetMetric: "ctr",
    });
    const calls: number[] = [];
    const variants = await svc.generateVariants(
      exp.id,
      "t3",
      99,
      async ({ count }) => {
        calls.push(count);
        return Array.from({ length: count }, (_, i) => ({
          label: `v${i}`,
          payload: { headline: `h${i}` },
        }));
      },
    );
    expect(calls[0]).toBe(50);
    expect(variants.length).toBe(50);
  });
});

describe("allocate / recordOutcome", () => {
  it("allocates a registered variant and records a conversion outcome", async () => {
    const { svc, store } = makeService();
    const exp = await svc.createExperiment({
      tenantId: "t4",
      name: "n",
      surface: "cta_text",
      targetMetric: "ctr",
    });
    const vs = await svc.generateVariants(exp.id, "t4", 2, async () => [
      { label: "a", payload: { cta: "Buy" } },
      { label: "b", payload: { cta: "Shop" } },
    ]);
    const alloc = await svc.allocate(exp.id, "t4", () => 0.5);
    expect(vs.map((v) => v.id)).toContain(alloc.variantId);

    await svc.recordOutcome({
      experimentId: exp.id,
      variantId: vs[0]!.id,
      tenantId: "t4",
      eventType: "conversion",
    });
    const post = await store.listVariantPosteriors(exp.id, "t4");
    const updated = post.find((p) => p.id === vs[0]!.id)!;
    expect(updated.alpha).toBe(2); // 1 + success
    expect(updated.impressions).toBe(1);
  });

  it("uses uniform allocation when rand falls under the exploration floor", async () => {
    const { svc } = makeService();
    const exp = await svc.createExperiment({
      tenantId: "t5",
      name: "n",
      surface: "cta_text",
      targetMetric: "ctr",
    });
    await svc.generateVariants(exp.id, "t5", 2, async () => [
      { label: "a", payload: { cta: "A" } },
      { label: "b", payload: { cta: "B" } },
    ]);
    const alloc = await svc.allocate(exp.id, "t5", () => 0.01);
    expect(alloc.source).toBe("epsilon_greedy");
  });

  it("throws when there are no variants", async () => {
    const { svc } = makeService();
    const exp = await svc.createExperiment({
      tenantId: "t6",
      name: "n",
      surface: "cta_text",
      targetMetric: "ctr",
    });
    await expect(svc.allocate(exp.id, "t6")).rejects.toThrow(/no variants/);
  });
});

describe("determineWinner", () => {
  async function seedTwoVariants(tenantId: string) {
    const { svc, store } = makeService();
    const exp = await svc.createExperiment({
      tenantId,
      name: "n",
      surface: "cta_text",
      targetMetric: "ctr",
    });
    await svc.generateVariants(exp.id, tenantId, 2, async () => [
      { label: "a", payload: { cta: "A" } },
      { label: "b", payload: { cta: "B" } },
    ]);
    return { svc, store, exp };
  }

  it("returns insufficient_variants when fewer than 2 variants", async () => {
    const { svc } = makeService();
    const exp = await svc.createExperiment({
      tenantId: "t7",
      name: "n",
      surface: "cta_text",
      targetMetric: "ctr",
    });
    const d = await svc.determineWinner(exp.id, "t7");
    expect(d.rationale).toBe("insufficient_variants");
    expect(d.winnerVariantId).toBeNull();
  });

  it("declares a winner when significance + posterior both pass", async () => {
    const { svc, exp } = await seedTwoVariants("t8");
    const d = await svc.determineWinner(exp.id, "t8", 0.9, 0);
    expect(d.rationale).toBe("winner_declared");
    expect(d.winnerVariantId).toBeTruthy();
    expect(d.decidedAt).toBeTruthy();
  });

  it("does not declare when posterior is below threshold", async () => {
    const lowProbAllocator: Allocator = {
      ...stubAllocator,
      posteriorBestProbability: () => 0.5,
    };
    const { store } = makeStore();
    const svc = new AbTestingService({
      store,
      allocator: lowProbAllocator,
      significance: winnerSignificance,
    });
    const exp = await svc.createExperiment({
      tenantId: "t9",
      name: "n",
      surface: "cta_text",
      targetMetric: "ctr",
    });
    await svc.generateVariants(exp.id, "t9", 2, async () => [
      { label: "a", payload: { cta: "A" } },
      { label: "b", payload: { cta: "B" } },
    ]);
    const d = await svc.determineWinner(exp.id, "t9", 0.9, 0);
    expect(d.rationale).toBe("posterior_below_threshold");
    expect(d.winnerVariantId).toBeNull();
  });

  it("keeps running when significance says still_running", async () => {
    const stillRunning: SignificanceTester = () => ({
      status: "still_running",
      winnerId: null,
      intervals: [],
      reason: "overlap",
    });
    const { store } = makeStore();
    const svc = new AbTestingService({
      store,
      allocator: stubAllocator,
      significance: stillRunning,
    });
    const exp = await svc.createExperiment({
      tenantId: "t10",
      name: "n",
      surface: "cta_text",
      targetMetric: "ctr",
    });
    await svc.generateVariants(exp.id, "t10", 2, async () => [
      { label: "a", payload: { cta: "A" } },
      { label: "b", payload: { cta: "B" } },
    ]);
    const d = await svc.determineWinner(exp.id, "t10", 0.9, 0);
    expect(d.rationale).toBe("overlap");
    expect(d.winnerVariantId).toBeNull();
  });
});
