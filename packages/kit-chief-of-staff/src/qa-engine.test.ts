import { describe, expect, it } from "vitest";
import {
  QaEngine,
  QaFlagDisabledError,
  QA_NO_LLM_MESSAGE,
  QA_NO_RESULT_MESSAGE,
  clampTopK,
  type DecisionSearcher,
} from "./qa-engine";
import { InMemoryDigestStore } from "./stores";
import { mockLlm } from "./test-helpers";

async function seedDigest(store: InMemoryDigestStore, n = 1, relevance = 0.9) {
  for (let i = 0; i < n; i++) {
    await store.insert({
      tenantId: "t1",
      sourceType: "slack",
      sourcePermalink: `https://slack.example/${i}`,
      sourceActor: null,
      rawTextPreview: "raw",
      rawTextTruncated: false,
      summary: `digest ${i}`,
      tags: [],
      relevanceScore: relevance,
    });
  }
}

describe("clampTopK", () => {
  it("既定 8・上限 20・不正値は既定", () => {
    expect(clampTopK(undefined)).toBe(8);
    expect(clampTopK(0)).toBe(8);
    expect(clampTopK(-3)).toBe(8);
    expect(clampTopK(NaN)).toBe(8);
    expect(clampTopK(5.9)).toBe(5);
    expect(clampTopK(100)).toBe(20);
  });
});

describe("QaEngine.ask", () => {
  it("フラグ無効なら QaFlagDisabledError", async () => {
    const engine = new QaEngine({
      digestStore: new InMemoryDigestStore(),
      isEnabled: () => false,
    });
    await expect(engine.ask({ tenantId: "t1", question: "q" })).rejects.toThrow(
      QaFlagDisabledError,
    );
  });

  it("空質問は no-result（検索もしない）", async () => {
    const engine = new QaEngine({ digestStore: new InMemoryDigestStore() });
    const res = await engine.ask({ tenantId: "t1", question: "   " });
    expect(res).toEqual({ answer: QA_NO_RESULT_MESSAGE, citations: [], hasAnswer: false });
  });

  it("根拠ゼロなら hasAnswer=false（捏造しない）", async () => {
    const engine = new QaEngine({
      digestStore: new InMemoryDigestStore(),
      llm: mockLlm(),
    });
    const res = await engine.ask({ tenantId: "t1", question: "先週の広告は？" });
    expect(res.hasAnswer).toBe(false);
    expect(res.citations).toHaveLength(0);
  });

  it("relevance 0.5 未満の digest は候補にならない", async () => {
    const store = new InMemoryDigestStore();
    await seedDigest(store, 3, 0.3);
    const engine = new QaEngine({ digestStore: store, llm: mockLlm() });
    const res = await engine.ask({ tenantId: "t1", question: "q" });
    expect(res.hasAnswer).toBe(false);
  });

  it("digest + decision の引用を合成して回答する", async () => {
    const store = new InMemoryDigestStore();
    await seedDigest(store, 2);
    const decisionSearcher: DecisionSearcher = {
      search: async () => [
        {
          id: "dec-12345678",
          decisionType: "budget",
          subject: "TV予算",
          reason: "MMMの弾力性が低いため削減",
          similarity: 0.82,
        },
      ],
    };
    let capturedPrompt = "";
    const engine = new QaEngine({
      digestStore: store,
      llm: mockLlm({
        generateText: async (_s, p) => {
          capturedPrompt = p;
          return "回答 [source: decision_log, id: dec-1234]";
        },
      }),
      embedder: async () => [0.1, 0.2],
      decisionSearcher,
    });

    const res = await engine.ask({ tenantId: "t1", question: "TV予算はなぜ減った？" });
    expect(res.hasAnswer).toBe(true);
    expect(res.citations).toHaveLength(3);
    expect(res.citations.filter((c) => c.source === "cos_digest")).toHaveLength(2);
    const decision = res.citations.find((c) => c.source === "decision_log")!;
    expect(decision.summaryOrReason).toBe("TV予算: MMMの弾力性が低いため削減");
    expect(decision.similarity).toBe(0.82);
    expect(capturedPrompt).toContain("質問: TV予算はなぜ減った？");
    expect(capturedPrompt).toContain("[source: decision_log, id: dec-1234");
  });

  it("LLM 未注入なら引用候補のみ返す（hasAnswer=true）", async () => {
    const store = new InMemoryDigestStore();
    await seedDigest(store, 1);
    const engine = new QaEngine({ digestStore: store });
    const res = await engine.ask({ tenantId: "t1", question: "q" });
    expect(res.answer).toBe(QA_NO_LLM_MESSAGE);
    expect(res.hasAnswer).toBe(true);
    expect(res.citations).toHaveLength(1);
  });

  it("LLM が空応答でも citations は返す", async () => {
    const store = new InMemoryDigestStore();
    await seedDigest(store, 1);
    const engine = new QaEngine({
      digestStore: store,
      llm: mockLlm({ generateText: async () => "" }),
    });
    const res = await engine.ask({ tenantId: "t1", question: "q" });
    expect(res.answer).toContain("回答を生成できませんでした");
    expect(res.citations).toHaveLength(1);
  });

  it("digest は topK で bound される", async () => {
    const store = new InMemoryDigestStore();
    await seedDigest(store, 10);
    const engine = new QaEngine({ digestStore: store, llm: mockLlm() });
    const res = await engine.ask({ tenantId: "t1", question: "q", topK: 3 });
    expect(res.citations).toHaveLength(3);
  });
});
