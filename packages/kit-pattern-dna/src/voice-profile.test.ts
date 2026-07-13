/**
 * 出典テスト: 実運用SaaS tests/company-dna-brand-voice.test.ts
 * （コア部分を移植。Claude モック → LlmCaller スタブ、Supabase → InMemoryDnaStore）。
 */
import { describe, it, expect } from "vitest";
import {
  aggregateFeatures,
  buildVoicePrompt,
  confidenceFromSamples,
  extractStyleFeatures,
  normalizeProfile,
  trainVoiceProfile,
  type VoiceProfile,
} from "./voice-profile.js";
import { InMemoryDnaStore } from "./stores.js";
import type { LlmCaller } from "./types.js";

const TENANT = "tenant-1";

function llmReturning(profile: Partial<VoiceProfile>): LlmCaller {
  return {
    async generateJson<T>(_s: string, _p: string, _f: T): Promise<T> {
      return profile as unknown as T;
    },
  };
}

describe("extractStyleFeatures", () => {
  it("returns zeroed features for empty / non-string input", () => {
    for (const input of ["", "   ", null, undefined, 42]) {
      const f = extractStyleFeatures(input);
      expect(f.charCount).toBe(0);
      expect(f.sentenceCount).toBe(0);
      expect(f.topTokens).toEqual([]);
      expect(f.tone).toEqual({ questions: 0, exclamations: 0, politeJa: 0, casualJa: 0 });
    }
  });

  it("counts sentences, words and tone signals (JA + EN)", () => {
    const f = extractStyleFeatures("これはテストです。よろしくお願いします！ 本当に？");
    expect(f.sentenceCount).toBe(3);
    expect(f.tone.politeJa).toBe(2); // です / ます
    expect(f.tone.exclamations).toBe(1);
    expect(f.tone.questions).toBe(1);
  });

  it("ranks top tokens by frequency (len ≥ 2, lowercased, max 8)", () => {
    const f = extractStyleFeatures("apple apple banana Apple cherry banana x");
    expect(f.topTokens[0]).toBe("apple");
    expect(f.topTokens[1]).toBe("banana");
    expect(f.topTokens).not.toContain("x"); // len < 2
    expect(f.uniqueTokens).toBe(3);
  });
});

describe("aggregateFeatures", () => {
  it("returns zeroed aggregate for empty input", () => {
    const agg = aggregateFeatures([]);
    expect(agg.sampleCount).toBe(0);
    expect(agg.meanCharCount).toBe(0);
    expect(agg.topTokens).toEqual([]);
  });

  it("averages numeric features and merges topTokens by doc frequency", () => {
    const a = extractStyleFeatures("alpha alpha beta");
    const b = extractStyleFeatures("alpha gamma gamma");
    const agg = aggregateFeatures([a, b]);
    expect(agg.sampleCount).toBe(2);
    expect(agg.meanWordCount).toBeCloseTo(3, 10);
    expect(agg.topTokens[0]).toBe("alpha"); // 両方に出現
  });
});

describe("buildVoicePrompt", () => {
  it("embeds aggregates + truncated snippets and demands JSON only", () => {
    const agg = aggregateFeatures([extractStyleFeatures("hello world.")]);
    const long = "y".repeat(500);
    const { system, user } = buildVoicePrompt({
      approvedAgg: agg,
      rejectedAgg: agg,
      approvedSnippets: [long, "s2", "s3", "s4"],
      rejectedSnippets: [],
    });
    expect(system).toContain("JSON only");
    expect(user).toContain("## APPROVED corpus");
    expect(user).toContain("## REJECTED corpus");
    expect(user).toContain("(none)"); // rejected snippets 空
    expect(user).not.toContain("s4"); // maxCount=3
    expect(user).toContain("…"); // 240 文字で切り詰め
  });

  it("allows overriding the system prompt", () => {
    const agg = aggregateFeatures([]);
    const { system } = buildVoicePrompt({
      approvedAgg: agg, rejectedAgg: agg, approvedSnippets: [], rejectedSnippets: [],
      systemPrompt: "custom analyst",
    });
    expect(system).toBe("custom analyst");
  });
});

describe("normalizeProfile", () => {
  it("trims strings, filters arrays, caps at 12, and drops empty notes", () => {
    const p = normalizeProfile({
      tone: "  polite  ",
      preferred: [" a ", "", 3 as unknown as string, ...Array(20).fill("x")],
      avoid: undefined as unknown as string[],
      sentenceLength: undefined,
      vocabulary: "b2b",
      notes: "   ",
    });
    expect(p.tone).toBe("polite");
    expect(p.preferred[0]).toBe("a");
    expect(p.preferred.length).toBeLessThanOrEqual(12);
    expect(p.avoid).toEqual([]);
    expect(p.notes).toBeUndefined();
    expect(normalizeProfile(null).tone).toBe("");
  });
});

describe("confidenceFromSamples", () => {
  it("returns floor 0.3 when either side is empty", () => {
    expect(confidenceFromSamples(0, 5)).toBe(0.3);
    expect(confidenceFromSamples(5, 0)).toBe(0.3);
  });

  it("rises with size and balance, capped at 0.95", () => {
    const small = confidenceFromSamples(1, 1);
    const big = confidenceFromSamples(10, 10);
    expect(big).toBeGreaterThan(small);
    expect(confidenceFromSamples(1000, 1000)).toBeLessThanOrEqual(0.95);
    const balanced = confidenceFromSamples(5, 5);
    const skewed = confidenceFromSamples(9, 1);
    expect(balanced).toBeGreaterThan(skewed);
  });
});

describe("trainVoiceProfile", () => {
  const goodProfile: VoiceProfile = {
    tone: "polite",
    preferred: ["です・ます"],
    avoid: ["俗語"],
    sentenceLength: "short",
    vocabulary: "b2b",
  };

  it("rejects empty approved / rejected corpora (blank-only filtered)", async () => {
    const deps = { llm: llmReturning(goodProfile), store: new InMemoryDnaStore() };
    expect(
      await trainVoiceProfile(deps, { tenantId: TENANT, approved: ["", "  "], rejected: ["x"] }),
    ).toEqual({ ok: false, error: "approved_required" });
    expect(
      await trainVoiceProfile(deps, { tenantId: TENANT, approved: ["x"], rejected: [] }),
    ).toEqual({ ok: false, error: "rejected_required" });
  });

  it("returns synthesis_empty when the LLM yields a hollow profile", async () => {
    const deps = {
      llm: llmReturning({ tone: "", preferred: [], avoid: [] }),
      store: new InMemoryDnaStore(),
    };
    const res = await trainVoiceProfile(deps, {
      tenantId: TENANT, approved: ["good text"], rejected: ["bad text"],
    });
    expect(res).toEqual({ ok: false, error: "synthesis_empty" });
  });

  it("persists the profile row under (brand_voice, default) with confidence in range", async () => {
    const store = new InMemoryDnaStore();
    const res = await trainVoiceProfile(
      { llm: llmReturning(goodProfile), store },
      {
        tenantId: TENANT,
        approved: ["丁寧な文章です。", "こちらも承認された文章です。"],
        rejected: ["ダメだぜ！"],
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.row.dnaType).toBe("brand_voice");
    expect(res.value.row.key).toBe("default");
    expect(res.value.row.source).toBe("brand_voice:train");
    expect(res.value.row.confidence).toBeGreaterThanOrEqual(0.3);
    expect(res.value.row.confidence).toBeLessThanOrEqual(0.95);
    expect(res.value.profile.tone).toBe("polite");
    expect(res.value.features.approved.sampleCount).toBe(2);
    expect(res.value.features.rejected.sampleCount).toBe(1);

    const persisted = await store.get(TENANT, "brand_voice", "default");
    expect(persisted).not.toBeNull();
    expect((persisted!.value.sampleCounts as { approved: number }).approved).toBe(2);
  });

  it("honours custom key / source", async () => {
    const store = new InMemoryDnaStore();
    const res = await trainVoiceProfile(
      { llm: llmReturning(goodProfile), store },
      {
        tenantId: TENANT,
        approved: ["a"],
        rejected: ["b"],
        key: " sales ",
        source: " manual:train ",
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.row.key).toBe("sales");
    expect(res.value.row.source).toBe("manual:train");
  });

  it("returns ingest_failed when persistence fails", async () => {
    const store = new InMemoryDnaStore();
    store.upsert = async () => null;
    const res = await trainVoiceProfile(
      { llm: llmReturning(goodProfile), store },
      { tenantId: TENANT, approved: ["a"], rejected: ["b"] },
    );
    expect(res).toEqual({ ok: false, error: "ingest_failed" });
  });
});
