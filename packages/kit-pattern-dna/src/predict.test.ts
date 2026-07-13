/**
 * 出典テスト: 実運用SaaS tests/company-dna-predict.test.ts
 * （コア部分を移植。Supabase → InMemoryDnaStore、env API キー → LlmCaller 注入）。
 */
import { describe, it, expect } from "vitest";
import {
  confidenceFromSampleSize,
  extractSample,
  fetchContentSamples,
  linearRegression,
  mean,
  predictContentScoreFromSamples,
  predictFromRegression,
  recommendChannelFromSamples,
  type ContentSample,
} from "./predict.js";
import { InMemoryDnaStore } from "./stores.js";
import type { LlmCaller } from "./types.js";

const TENANT = "tenant-1";

function sample(overrides: Partial<ContentSample> = {}): ContentSample {
  return { theme: "ai", channel: "blog", length: 1000, pv: 100, cv: 5, ...overrides };
}

describe("linearRegression", () => {
  it("recovers a perfect line", () => {
    // y = 2x + 1
    const { slope, intercept } = linearRegression([1, 2, 3], [3, 5, 7]);
    expect(slope).toBeCloseTo(2, 10);
    expect(intercept).toBeCloseTo(1, 10);
  });

  it("degrades to slope=0 / intercept=mean(y) when var(x)=0", () => {
    const { slope, intercept } = linearRegression([5, 5, 5], [1, 2, 3]);
    expect(slope).toBe(0);
    expect(intercept).toBeCloseTo(2, 10);
  });

  it("returns zeros for empty / mismatched input", () => {
    expect(linearRegression([], [])).toEqual({ slope: 0, intercept: 0 });
    expect(linearRegression([1], [1, 2])).toEqual({ slope: 0, intercept: 0 });
  });
});

describe("predictFromRegression / mean / confidenceFromSampleSize", () => {
  it("clamps negative predictions to 0", () => {
    expect(predictFromRegression({ slope: -1, intercept: 0 }, 10)).toBe(0);
    expect(predictFromRegression({ slope: 2, intercept: 1 }, 3)).toBe(7);
  });

  it("mean handles empty input", () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
  });

  it("buckets confidence by sample size", () => {
    expect(confidenceFromSampleSize(2)).toBe("low");
    expect(confidenceFromSampleSize(5)).toBe("medium");
    expect(confidenceFromSampleSize(10)).toBe("high");
  });
});

describe("extractSample", () => {
  it("extracts a valid sample and defaults length to 0", () => {
    const s = extractSample({
      dnaType: "content",
      value: { theme: " ai ", channel: "blog", pv: 10, cv: 1 },
    });
    expect(s).toEqual({ theme: "ai", channel: "blog", length: 0, pv: 10, cv: 1 });
  });

  it("returns null for wrong dnaType or missing / invalid fields", () => {
    expect(
      extractSample({ dnaType: "glossary", value: { theme: "a", channel: "b", pv: 1, cv: 1 } }),
    ).toBeNull();
    expect(extractSample({ dnaType: "content", value: { channel: "b", pv: 1, cv: 1 } })).toBeNull();
    expect(
      extractSample({ dnaType: "content", value: { theme: "a", channel: "b", pv: -1, cv: 1 } }),
    ).toBeNull();
    expect(
      extractSample({ dnaType: "content", value: { theme: "a", channel: "b", pv: 1, cv: "x" } }),
    ).toBeNull();
  });
});

describe("fetchContentSamples", () => {
  it("pulls only extractable content rows from the store", async () => {
    const store = new InMemoryDnaStore();
    await store.upsert({
      tenantId: TENANT, dnaType: "content", key: "ok",
      value: { theme: "ai", channel: "blog", length: 500, pv: 10, cv: 1 },
      source: "m", confidence: 1,
    });
    await store.upsert({
      tenantId: TENANT, dnaType: "content", key: "broken",
      value: { pv: 10 }, source: "m", confidence: 1,
    });
    await store.upsert({
      tenantId: TENANT, dnaType: "glossary", key: "term",
      value: { theme: "ai", channel: "blog", pv: 1, cv: 1 }, source: "m", confidence: 1,
    });
    const samples = await fetchContentSamples(store, TENANT);
    expect(samples.length).toBe(1);
    expect(samples[0]?.length).toBe(500);
  });
});

describe("predictContentScoreFromSamples", () => {
  it("uses regression with ≥3 theme+channel matches and a length", async () => {
    // pv = 0.1 × length
    const samples = [
      sample({ length: 1000, pv: 100, cv: 10 }),
      sample({ length: 2000, pv: 200, cv: 20 }),
      sample({ length: 3000, pv: 300, cv: 30 }),
    ];
    const out = await predictContentScoreFromSamples(samples, {
      tenantId: TENANT, theme: "ai", channel: "blog", length: 1500,
    });
    expect(out.usedRegression).toBe(true);
    expect(out.predictedPv).toBe(150);
    expect(out.predictedCv).toBe(15);
    expect(out.sampleSize).toBe(3);
    expect(out.reason).toContain("regression_on_3");
  });

  it("falls back to theme+channel mean without a length", async () => {
    const samples = [sample({ pv: 100 }), sample({ pv: 300 })];
    const out = await predictContentScoreFromSamples(samples, {
      tenantId: TENANT, theme: "ai", channel: "blog",
    });
    expect(out.usedRegression).toBe(false);
    expect(out.predictedPv).toBe(200);
    expect(out.reason).toContain("mean_of_2");
  });

  it("falls back to channel-only mean when the theme is unseen", async () => {
    const samples = [sample({ theme: "other", pv: 40 })];
    const out = await predictContentScoreFromSamples(samples, {
      tenantId: TENANT, theme: "ai", channel: "blog",
    });
    expect(out.predictedPv).toBe(40);
    expect(out.confidence).toBe("low");
    expect(out.reason).toContain("fallback_channel_mean_1");
  });

  it("returns zeros when nothing matches", async () => {
    const out = await predictContentScoreFromSamples([], {
      tenantId: TENANT, theme: "ai", channel: "blog",
    });
    expect(out.predictedPv).toBe(0);
    expect(out.sampleSize).toBe(0);
    expect(out.reason).toBe("insufficient_data_no_matches");
  });

  it("applies the LLM sanity adjustment only when reasonable=false", async () => {
    const samples = [sample({ pv: 100 }), sample({ pv: 100 })];
    const input = {
      tenantId: TENANT, theme: "ai", channel: "blog", sanityCheck: true,
    };

    const agreeable: LlmCaller = {
      async generateJson<T>(): Promise<T> {
        return { reasonable: true } as unknown as T;
      },
    };
    const kept = await predictContentScoreFromSamples(samples, input, agreeable);
    expect(kept.predictedPv).toBe(100);
    expect(kept.reason).not.toContain("llm_adjusted");

    const critic: LlmCaller = {
      async generateJson<T>(): Promise<T> {
        return { reasonable: false, pv_adjustment: 0.9, cv_adjustment: -0.9 } as unknown as T;
      },
    };
    const adjusted = await predictContentScoreFromSamples(samples, input, critic);
    // 調整は ±0.2 にクランプされる
    expect(adjusted.predictedPv).toBe(120);
    expect(adjusted.reason).toContain("llm_adjusted");

    // llm 未注入なら sanityCheck 指定でも素通し
    const plain = await predictContentScoreFromSamples(samples, input);
    expect(plain.predictedPv).toBe(100);
  });
});

describe("recommendChannelFromSamples", () => {
  it("ranks channels by ROI with no-data channels last", () => {
    const samples = [
      sample({ channel: "email", pv: 100, cv: 10 }), // roi 0.1
      sample({ channel: "blog", pv: 100, cv: 2 }), // roi 0.02
    ];
    const recs = recommendChannelFromSamples(samples, {
      tenantId: TENANT, theme: "ai", channels: ["blog", "email", "social"],
    });
    expect(recs.map((r) => r.channel)).toEqual(["email", "blog", "social"]);
    expect(recs[0]?.expectedRoi).toBeCloseTo(0.1, 10);
    expect(recs[2]?.sampleSize).toBe(0);
  });

  it("averages multiple samples per channel", () => {
    const samples = [
      sample({ channel: "blog", pv: 100, cv: 10 }),
      sample({ channel: "blog", pv: 300, cv: 30 }),
    ];
    const recs = recommendChannelFromSamples(samples, {
      tenantId: TENANT, theme: "ai", channels: ["blog"],
    });
    expect(recs[0]?.expectedPv).toBe(200);
    expect(recs[0]?.expectedCv).toBe(20);
    expect(recs[0]?.sampleSize).toBe(2);
  });
});
