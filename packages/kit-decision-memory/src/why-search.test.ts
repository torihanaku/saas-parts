import { describe, expect, it } from "vitest";
import { InMemoryDecisionStore } from "./stores.js";
import { seedDecisions, TENANT } from "./test-helpers.js";
import { DecisionMemoryValidationError } from "./types.js";
import { WhySearchService } from "./why-search.js";

/** 決定的ランキング検証用フィクスチャ。 */
async function seededStore(): Promise<InMemoryDecisionStore> {
  const store = new InMemoryDecisionStore();
  await seedDecisions(store, [
    {
      id: "dec-fb-stop",
      decisionType: "stop",
      subject: "Facebook 広告の停止",
      reason: "CPA が目標の 2 倍に高騰したため",
      context: "2026年6月のマーケ定例で決定",
    },
    {
      id: "dec-blog-start",
      decisionType: "start",
      subject: "ブログ週3回投稿の開始",
      reason: "オーガニック流入を強化するため",
      context: "SEO 施策の一環",
    },
    {
      id: "dec-fb-budget",
      decisionType: "change",
      subject: "Facebook 広告予算の増額",
      reason: "ROAS が好調だったため",
      context: "2026年3月時点の判断",
    },
  ]);
  return store;
}

describe("WhySearchService (BM25 フォールバック)", () => {
  it("質問に最も関連する決定を先頭 citation に返す（決定的）", async () => {
    const service = new WhySearchService({ store: await seededStore() });
    const result = await service.search({
      tenantId: TENANT,
      question: "なぜ Facebook 広告を停止したのか",
    });
    expect(result.hasAnswer).toBe(true);
    expect(result.citations[0]?.decisionId).toBe("dec-fb-stop");
    // 無関係なブログ施策より Facebook 系 2 件が上位
    const ids = result.citations.map((c) => c.decisionId);
    expect(ids.indexOf("dec-fb-stop")).toBeLessThan(ids.indexOf("dec-fb-budget"));
    // similarity は最上位 1.0 の正規化値
    expect(result.citations[0]?.similarity).toBe(1);
  });

  it("同じ質問に対して常に同じ citations を返す", async () => {
    const service = new WhySearchService({ store: await seededStore() });
    const input = { tenantId: TENANT, question: "Facebook 広告" };
    const first = await service.search(input);
    for (let i = 0; i < 3; i++) {
      expect((await service.search(input)).citations).toEqual(first.citations);
    }
  });

  it("LLM 未注入時は noLlmMessage を answer に返す（citations は保持）", async () => {
    const service = new WhySearchService({ store: await seededStore() });
    const result = await service.search({ tenantId: TENANT, question: "広告" });
    expect(result.hasAnswer).toBe(true);
    expect(result.answer).toContain("AI 要約は無効です");
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it("記録ゼロ（無関係の質問）は hasAnswer=false", async () => {
    const service = new WhySearchService({ store: await seededStore() });
    const result = await service.search({ tenantId: TENANT, question: "zzz_nomatch" });
    expect(result).toEqual({
      answer: "関連する意思決定の記録が見つかりませんでした。",
      citations: [],
      hasAnswer: false,
    });
  });

  it("generateText 注入時は根拠ブロック付きプロンプトで回答を生成する", async () => {
    const prompts: Array<{ system: string; user: string }> = [];
    const service = new WhySearchService({
      store: await seededStore(),
      generateText: async (system, user) => {
        prompts.push({ system, user });
        return "CPA 高騰が理由です [ID: dec-fb-s]";
      },
    });
    const result = await service.search({
      tenantId: TENANT,
      question: "なぜ Facebook 広告を停止したのか",
    });
    expect(result.answer).toBe("CPA 高騰が理由です [ID: dec-fb-s]");
    expect(prompts[0]?.user).toContain("質問: なぜ Facebook 広告を停止したのか");
    expect(prompts[0]?.user).toContain("根拠: CPA が目標の 2 倍に高騰したため");
  });

  it("空の質問はバリデーションエラー", async () => {
    const service = new WhySearchService({ store: new InMemoryDecisionStore() });
    await expect(service.search({ tenantId: TENANT, question: "  " })).rejects.toThrow(
      DecisionMemoryValidationError,
    );
  });

  it("EmbeddingSearcher 注入時はそちらを優先し、topK / threshold を渡す", async () => {
    const calls: unknown[] = [];
    const service = new WhySearchService({
      store: await seededStore(),
      threshold: 0.7,
      searcher: {
        search: async (query, opts) => {
          calls.push({ query, opts });
          return [{ id: "dec-blog-start", similarity: 0.91 }];
        },
      },
    });
    const result = await service.search({ tenantId: TENANT, question: "Facebook", topK: 3 });
    expect(calls).toEqual([
      { query: "Facebook", opts: { tenantId: TENANT, topK: 3, threshold: 0.7 } },
    ]);
    // BM25 なら fb 系が先頭になるはずが、searcher の結果が優先される
    expect(result.citations).toEqual([
      {
        decisionId: "dec-blog-start",
        decisionType: "start",
        subject: "ブログ週3回投稿の開始",
        decidedAt: expect.any(String),
        similarity: 0.91,
      },
    ]);
  });
});
