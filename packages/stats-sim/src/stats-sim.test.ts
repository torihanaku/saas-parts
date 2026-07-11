import { describe, it, expect } from "vitest";
import {
  runMonteCarlo,
  makeRng,
  __monteCarloTesting,
  extractElasticitiesFromMmm,
  extractElasticitiesWithCausalPreference,
  buildCausalElasticityTable,
  channelToInputKey,
  FALLBACK_ELASTICITIES,
  type MonteCarloInput,
  type MmmResultRow,
  type CausalToTwinLink,
} from "./index";

// ── monte-carlo ──────────────────────────────────────────────────────────────

const baseInput: MonteCarloInput = {
  baseline: {
    pv: { mean: 1000, std: 100 },
    cv: { mean: 20, std: 4 },
    blog_count: { mean: 4, std: 0 },
  },
  scenarioInputs: { blog_count: 8 },
  elasticities: { blog_count: { pv: 150, cv: 3 } },
  trials: 1000,
  seed: 42,
};

describe("runMonteCarlo", () => {
  it("is deterministic for the same seed (golden)", () => {
    const a = runMonteCarlo(baseInput);
    const b = runMonteCarlo(baseInput);
    expect(a).toEqual(b);
  });

  it("differs for different seeds", () => {
    const a = runMonteCarlo(baseInput);
    const b = runMonteCarlo({ ...baseInput, seed: 7 });
    expect(a.pv!.mean).not.toBe(b.pv!.mean);
  });

  it("shifts the mean by (input - baseline) * elasticity", () => {
    const out = runMonteCarlo(baseInput);
    // pv: 1000 + (8-4)*150 = 1600 expected, cv: 20 + (8-4)*3 = 32
    expect(out.pv!.mean).toBeGreaterThan(1450);
    expect(out.pv!.mean).toBeLessThan(1750);
    expect(out.cv!.mean).toBeGreaterThan(28);
    expect(out.cv!.mean).toBeLessThan(36);
  });

  it("returns ordered percentiles p5 <= p50 <= p95", () => {
    const out = runMonteCarlo(baseInput);
    for (const k of Object.keys(out)) {
      expect(out[k]!.p5).toBeLessThanOrEqual(out[k]!.p50);
      expect(out[k]!.p50).toBeLessThanOrEqual(out[k]!.p95);
    }
  });

  it("clamps negative predictions to 0", () => {
    const out = runMonteCarlo({
      baseline: { cv: { mean: 1, std: 10 } },
      scenarioInputs: {},
      elasticities: {},
      trials: 500,
      seed: 1,
    });
    expect(out.cv!.p5).toBeGreaterThanOrEqual(0);
  });

  it("accepts an injected RNG (takes precedence over seed)", () => {
    const a = runMonteCarlo({ ...baseInput, seed: 999, rng: makeRng(42) });
    const b = runMonteCarlo({ ...baseInput, seed: 42 });
    expect(a).toEqual(b);
  });

  it("caps trials to [1, 10000]", () => {
    const one = runMonteCarlo({ ...baseInput, trials: 0 });
    expect(one.pv).toBeDefined(); // trials clamped to 1, still runs
  });

  it("ignores unknown elasticity keys (treated as 0)", () => {
    const out = runMonteCarlo({
      ...baseInput,
      scenarioInputs: { unknown_input: 100 },
    });
    // No elasticity for unknown_input -> pv stays near baseline mean
    expect(out.pv!.mean).toBeGreaterThan(900);
    expect(out.pv!.mean).toBeLessThan(1100);
  });
});

describe("monte-carlo internals", () => {
  it("makeRng is deterministic and in [0,1)", () => {
    const r1 = makeRng(42);
    const r2 = makeRng(42);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      expect(v).toBe(r2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("quantile picks by floor index and handles empty arrays", () => {
    const { quantile } = __monteCarloTesting;
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 0.99)).toBe(4);
  });

  it("sampleNormal has ~0 mean and ~1 std over many draws", () => {
    const { sampleNormal } = __monteCarloTesting;
    const rng = makeRng(3);
    const n = 5000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = sampleNormal(rng);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    expect(mean).toBeCloseTo(0, 1);
    expect(Math.sqrt(sumSq / n - mean * mean)).toBeCloseTo(1, 1);
  });
});

// ── elasticity-extractor ─────────────────────────────────────────────────────

describe("channelToInputKey", () => {
  it("maps well-known channels to canonical keys", () => {
    expect(channelToInputKey("Blog Posts")).toBe("blog_count");
    expect(channelToInputKey("content_marketing")).toBe("blog_count");
    expect(channelToInputKey("google_ads")).toBe("ad_budget");
    expect(channelToInputKey("Meta Ads")).toBe("ad_budget");
    expect(channelToInputKey("facebook")).toBe("ad_budget");
    expect(channelToInputKey("Email Newsletter")).toBe("email_frequency");
  });

  it("passes through unknown channels as sanitized snake_case", () => {
    expect(channelToInputKey("TikTok Organic!")).toBe("tiktok_organic_");
  });
});

describe("extractElasticitiesFromMmm", () => {
  it("falls back when no MMM row is available", () => {
    const res = extractElasticitiesFromMmm(null);
    expect(res.table).toEqual(FALLBACK_ELASTICITIES);
    expect(res.warnings).toContain("mmm_not_available_using_fallback_elasticities");
    expect(res.fromMmm).toBe(false);
    expect(res.formHint).toBeNull();
  });

  it("falls back when the row has no channels", () => {
    const row: MmmResultRow = { channels: [], saturation_form: "hill" };
    const res = extractElasticitiesFromMmm(row);
    expect(res.table).toEqual(FALLBACK_ELASTICITIES);
    expect(res.warnings).toContain("mmm_result_has_no_channels_using_fallback");
    expect(res.formHint).toBe("hill");
  });

  it("projects each channel beta across pv/cv/revenue", () => {
    const row: MmmResultRow = {
      channels: [
        { channel: "google_ads", beta: 0.42 },
        { channel: "blog", beta: 120 },
      ],
      saturation_form: "hill",
    };
    const res = extractElasticitiesFromMmm(row);
    expect(res.fromMmm).toBe(true);
    expect(res.table.ad_budget).toEqual({ pv: 0.42, cv: 0.42, revenue: 0.42 });
    expect(res.table.blog_count).toEqual({ pv: 120, cv: 120, revenue: 120 });
    expect(res.warnings).toContain("mmm_nonlinear_local_slope_only");
  });

  it("skips channels with invalid beta and falls back when none usable", () => {
    const row: MmmResultRow = {
      channels: [{ channel: "email", beta: NaN }],
      saturation_form: "weibull",
    };
    const res = extractElasticitiesFromMmm(row);
    expect(res.fromMmm).toBe(false);
    expect(res.table).toEqual(FALLBACK_ELASTICITIES);
    expect(res.warnings).toContain("mmm_channels_unusable_using_fallback");
    expect(res.warnings).toContain("channel_email_invalid_beta");
  });
});

describe("buildCausalElasticityTable", () => {
  it("builds table + provenance and flags stale links", () => {
    const links: CausalToTwinLink[] = [
      { experimentId: "exp-1", channel: "google_ads", outputMetric: "revenue", effectSize: 0.9 },
      { experimentId: "exp-2", channel: "blog", outputMetric: "pv", effectSize: 200, stale: true, ageDays: 120 },
    ];
    const res = buildCausalElasticityTable(links);
    expect(res.table.ad_budget!.revenue).toBe(0.9);
    expect(res.table.blog_count!.pv).toBe(200);
    expect(res.provenance.ad_budget!.revenue).toBe("exp-1");
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("causal_link_stale");
    expect(res.warnings[0]).toContain("120 days old");
  });
});

describe("extractElasticitiesWithCausalPreference", () => {
  const mmmRow: MmmResultRow = {
    channels: [{ channel: "google_ads", beta: 0.42 }],
    saturation_form: "hill",
  };

  it("returns MMM result untouched when no causal links exist", () => {
    const res = extractElasticitiesWithCausalPreference(mmmRow, []);
    expect(res.hasCausalOverride).toBe(false);
    expect(res.causalProvenance).toEqual({});
    expect(res.table.ad_budget!.revenue).toBe(0.42);
  });

  it("overrides MMM beta per (inputKey, output) with causal effect size", () => {
    const links: CausalToTwinLink[] = [
      { experimentId: "exp-9", channel: "google_ads", outputMetric: "revenue", effectSize: 1.5 },
    ];
    const res = extractElasticitiesWithCausalPreference(mmmRow, links);
    expect(res.hasCausalOverride).toBe(true);
    expect(res.table.ad_budget!.revenue).toBe(1.5); // causal wins
    expect(res.table.ad_budget!.pv).toBe(0.42); // MMM kept
    expect(res.causalProvenance.ad_budget!.revenue).toBe("exp-9");
  });

  it("applies causal overrides on top of the fallback table when MMM is missing", () => {
    const links: CausalToTwinLink[] = [
      { experimentId: "exp-3", channel: "email", outputMetric: "cv", effectSize: 5 },
    ];
    const res = extractElasticitiesWithCausalPreference(null, links);
    expect(res.fromMmm).toBe(false);
    expect(res.table.email_frequency!.cv).toBe(5); // causal > fallback (1)
    expect(res.table.email_frequency!.pv).toBe(50); // fallback kept
    expect(res.hasCausalOverride).toBe(true);
  });
});
