/**
 * 出典テスト: 実運用SaaS tests/company-dna-content-ingest.test.ts
 * （コア部分を移植。Claude モック → LlmCaller スタブ、Supabase → InMemoryDnaStore）。
 */
import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_TIER_THRESHOLDS,
  classifyContentPattern,
  derivePerformanceTier,
  ingestContentDna,
  summariseRevisions,
  validateContentIngestRequest,
  type ContentPatternFeatures,
  type ValidatedContentIngest,
} from "./content-ingest.js";
import { InMemoryDnaStore } from "./stores.js";
import type { LlmCaller } from "./types.js";

const TENANT = "tenant-1";

function llmReturning(pattern: Partial<ContentPatternFeatures>): LlmCaller {
  return {
    async generateJson<T>(_s: string, _p: string, _f: T): Promise<T> {
      return pattern as unknown as T;
    },
  };
}

function validated(overrides: Partial<ValidatedContentIngest> = {}): ValidatedContentIngest {
  return {
    articleId: "a-1",
    title: "タイトル",
    body: "本文",
    pv: 1000,
    cv: 50,
    publishedAt: null,
    revisions: [],
    tags: [],
    source: "manual",
    ...overrides,
  };
}

describe("validateContentIngestRequest", () => {
  it("normalises a valid payload with defaults", () => {
    const res = validateContentIngestRequest({ article_id: " a-1 ", source: " manual " });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.articleId).toBe("a-1");
    expect(res.value.source).toBe("manual");
    expect(res.value.pv).toBe(0);
    expect(res.value.cv).toBe(0);
    expect(res.value.publishedAt).toBeNull();
    expect(res.value.revisions).toEqual([]);
    expect(res.value.tags).toEqual([]);
  });

  it("rejects missing article_id / source", () => {
    expect(validateContentIngestRequest({ source: "m" })).toEqual({
      ok: false, error: "article_id_required",
    });
    expect(validateContentIngestRequest({ article_id: "a" })).toEqual({
      ok: false, error: "source_required",
    });
  });

  it("rejects negative / non-numeric pv & cv but floors valid numbers", () => {
    expect(validateContentIngestRequest({ article_id: "a", source: "m", pv: -1 })).toEqual({
      ok: false, error: "pv_invalid",
    });
    expect(
      validateContentIngestRequest({ article_id: "a", source: "m", cv: "x" as never }),
    ).toEqual({ ok: false, error: "cv_invalid" });
    const ok = validateContentIngestRequest({ article_id: "a", source: "m", pv: 12.9 });
    expect(ok.ok && ok.value.pv).toBe(12);
  });

  it("rejects non-array revisions / tags and filters malformed entries", () => {
    expect(
      validateContentIngestRequest({ article_id: "a", source: "m", revisions: {} as never }),
    ).toEqual({ ok: false, error: "revisions_invalid" });
    expect(
      validateContentIngestRequest({ article_id: "a", source: "m", tags: "x" as never }),
    ).toEqual({ ok: false, error: "tags_invalid" });

    const res = validateContentIngestRequest({
      article_id: "a",
      source: "m",
      revisions: [{ comment: "ok" }, "bad" as never, { before: 3 as never }],
      tags: ["t1", 2 as never],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.revisions).toEqual([{ comment: "ok" }]);
    expect(res.value.tags).toEqual(["t1"]);
  });
});

describe("derivePerformanceTier", () => {
  it("is neutral below the pv floor regardless of cvr", () => {
    expect(derivePerformanceTier(49, 49)).toBe("neutral");
  });

  it("classifies success / failure / neutral by cvr", () => {
    expect(derivePerformanceTier(1000, 30)).toBe("success"); // cvr 0.03
    expect(derivePerformanceTier(1000, 4)).toBe("failure"); // cvr 0.004
    expect(derivePerformanceTier(1000, 10)).toBe("neutral"); // cvr 0.01
  });

  it("honours custom thresholds", () => {
    const t = { minPv: 10, successCvr: 0.5, failureCvr: 0.1 };
    expect(derivePerformanceTier(20, 10, t)).toBe("success");
    expect(derivePerformanceTier(20, 1, t)).toBe("failure");
    expect(derivePerformanceTier(5, 5, t)).toBe("neutral");
    expect(DEFAULT_TIER_THRESHOLDS.minPv).toBe(50);
  });
});

describe("summariseRevisions", () => {
  it("sums comment and diff chars across rounds", () => {
    const out = summariseRevisions([
      { comment: "12345", before: "ab", after: "cdef" },
      { comment: "xy" },
      {},
    ]);
    expect(out).toEqual({ count: 3, totalCommentChars: 7, totalDiffChars: 6 });
  });
});

describe("classifyContentPattern", () => {
  it("skips the LLM when llm=null and derives tier heuristically", async () => {
    const out = await classifyContentPattern(null, validated({ pv: 1000, cv: 50 }));
    expect(out.tier).toBe("success");
    expect(out.features).toEqual([]);
    expect(out.summary).toBe("");
  });

  it("normalises LLM output (caps arrays at 5, truncates summary, fixes bad tier)", async () => {
    const llm = llmReturning({
      tier: "bogus" as never,
      features: ["a", "b", "c", "d", "e", "f", 7 as never],
      revision_patterns: ["r1"],
      summary: "s".repeat(300),
    });
    const out = await classifyContentPattern(llm, validated({ pv: 1000, cv: 1 }));
    expect(out.tier).toBe("failure"); // heuristic backstop
    expect(out.features.length).toBe(5);
    expect(out.revision_patterns).toEqual(["r1"]);
    expect(out.summary.length).toBe(200);
  });

  it("includes article meta + revisions line in the user prompt", async () => {
    const spy = vi.fn();
    const llm: LlmCaller = {
      async generateJson<T>(_s: string, p: string, _f: T): Promise<T> {
        spy(p);
        return {
          tier: "neutral", features: [], revision_patterns: [], summary: "",
        } as unknown as T;
      },
    };
    await classifyContentPattern(llm, validated({ revisions: [{ comment: "直して" }] }));
    expect(spy).toHaveBeenCalledOnce();
    const prompt = spy.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("記事タイトル: タイトル");
    expect(prompt).toContain("修正履歴: 1 ラウンド");
  });
});

describe("ingestContentDna", () => {
  it("persists under key dna-content:<id> with confidence 0.9 for featured tiers", async () => {
    const store = new InMemoryDnaStore();
    const llm = llmReturning({
      tier: "success", features: ["結論先出し"], revision_patterns: [], summary: "良い",
    });
    const res = await ingestContentDna(
      { store, llm },
      { ...validated({ pv: 2000, cv: 100 }), tenantId: TENANT },
    );
    expect(res).not.toBeNull();
    expect(res!.row.dnaType).toBe("content");
    expect(res!.row.key).toBe("dna-content:a-1");
    expect(res!.row.confidence).toBe(0.9);
    expect(res!.row.value.tier).toBe("success");
    expect(res!.row.value.cvr).toBeCloseTo(0.05, 10);
    expect(res!.pattern.features).toEqual(["結論先出し"]);
  });

  it("uses confidence 0.5 for neutral / featureless patterns (llm omitted)", async () => {
    const store = new InMemoryDnaStore();
    const res = await ingestContentDna(
      { store },
      { ...validated({ pv: 10, cv: 0 }), tenantId: TENANT },
    );
    expect(res!.row.confidence).toBe(0.5);
    expect(res!.pattern.tier).toBe("neutral");
  });

  it("returns null when persistence fails", async () => {
    const store = new InMemoryDnaStore();
    store.upsert = async () => null;
    const res = await ingestContentDna({ store }, { ...validated(), tenantId: TENANT });
    expect(res).toBeNull();
  });
});
