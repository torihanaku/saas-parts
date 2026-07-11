import { describe, expect, it } from "vitest";
import { InstitutionalMemoryService } from "./memory-service.js";
import { extractFollowUps, OnboardingPersonaService } from "./onboarding-persona.js";
import { OnboardingService } from "./onboarding.js";
import { InMemoryDecisionStore, InMemoryMemoryStore } from "./stores.js";
import { seedDecisions, seedMemories, TENANT } from "./test-helpers.js";
import { DecisionMemoryValidationError } from "./types.js";

describe("OnboardingService.explainTopic (モック LLM)", () => {
  async function seededStore() {
    const store = new InMemoryDecisionStore();
    await seedDecisions(store, [
      { id: "d1", subject: "Facebook 広告の停止", reason: "CPA 高騰", decisionType: "stop" },
      { id: "d2", subject: "ブログ週3回投稿", reason: "SEO 強化", decisionType: "start" },
      { id: "d3", subject: "メールナーチャリング開始", reason: "リード育成", decisionType: "start" },
    ]);
    return store;
  }

  it("記録ゼロなら emptyMessage を返し LLM を呼ばない", async () => {
    let llmCalls = 0;
    const service = new OnboardingService({
      store: new InMemoryDecisionStore(),
      generateText: async () => {
        llmCalls++;
        return "should not be called";
      },
    });
    const result = await service.explainTopic({ tenantId: TENANT, topic: "マーケ方針" });
    expect(result.summary).toContain("記録がまだありません");
    expect(result.keyDecisions).toEqual([]);
    expect(llmCalls).toBe(0);
  });

  it("直近の決定を素材にモック LLM で要約し、keyDecisions を抜粋する", async () => {
    const prompts: Array<{ system: string; user: string }> = [];
    const service = new OnboardingService({
      store: await seededStore(),
      keyDecisionLimit: 2,
      generateText: async (system, user) => {
        prompts.push({ system, user });
        return "この組織は CPA 重視で意思決定しています。";
      },
    });
    const result = await service.explainTopic({ tenantId: TENANT, topic: "広告方針" });
    expect(result.summary).toBe("この組織は CPA 重視で意思決定しています。");
    expect(prompts[0]?.user).toContain("トピック: 広告方針");
    expect(prompts[0]?.user).toContain("- [stop] Facebook 広告の停止: CPA 高騰");
    expect(result.keyDecisions).toHaveLength(2);
    expect(result.keyDecisions[0]).toEqual({
      id: "d1",
      subject: "Facebook 広告の停止",
      reason: "CPA 高騰",
    });
  });

  it("channelKeywords 注入で knownChannels を抽出する", async () => {
    const service = new OnboardingService({
      store: await seededStore(),
      channelKeywords: ["Facebook", "メール", "TikTok"],
    });
    const result = await service.explainTopic({ tenantId: TENANT, topic: "チャネル" });
    expect(result.knownChannels.sort()).toEqual(["Facebook", "メール"]);
  });

  it("contextProvider の失敗は degrade して続行する", async () => {
    const prompts: string[] = [];
    const service = new OnboardingService({
      store: await seededStore(),
      contextProvider: async () => {
        throw new Error("context source down");
      },
      generateText: async (_s, user) => {
        prompts.push(user);
        return "ok";
      },
    });
    const result = await service.explainTopic({ tenantId: TENANT, topic: "方針" });
    expect(result.summary).toBe("ok");
    expect(prompts[0]).toContain("（コンテキスト情報の取得に失敗しました）");
  });

  it("LLM 未注入なら noLlmMessage、空トピックはバリデーションエラー", async () => {
    const service = new OnboardingService({ store: await seededStore() });
    const result = await service.explainTopic({ tenantId: TENANT, topic: "方針" });
    expect(result.summary).toContain("AI 要約機能を実行できません");
    await expect(service.explainTopic({ tenantId: TENANT, topic: " " })).rejects.toThrow(
      DecisionMemoryValidationError,
    );
  });
});

describe("OnboardingPersonaService (モック LLM)", () => {
  async function makePersona(generateText?: (s: string, u: string) => Promise<string>) {
    const store = new InMemoryMemoryStore();
    await seedMemories(store, [
      { id: "aaaaaaaa-1", memType: "decision_log", subject: "Facebook 広告の停止", content: "CPA 高騰のため" },
      { id: "bbbbbbbb-2", memType: "failure_recipe", subject: "値引き乱発の失敗", content: "LTV が悪化した" },
      { id: "cccccccc-3", memType: "success_recipe", subject: "ブログ強化の成功", content: "流入 2 倍" },
    ]);
    const memory = new InstitutionalMemoryService({ store });
    return new OnboardingPersonaService({ memory, generateText });
  }

  it("全 mem_type の根拠を統合し、citations と evidenceCounts を返す", async () => {
    const prompts: string[] = [];
    const persona = await makePersona(async (_s, u) => {
      prompts.push(u);
      return "統合回答 [#aaaaaaaa]\n\n### 次に聞くと良い質問\n- なぜ広告を止めた?\n- 失敗から何を学んだ?";
    });
    const result = await persona.answer({ tenantId: TENANT, question: "会社の方針を教えて" });
    expect(result.answer).toContain("統合回答");
    expect(result.evidenceCounts).toEqual({
      decision_log: 1,
      failure_recipe: 1,
      success_recipe: 1,
    });
    expect(result.citations.map((c) => c.ref).sort()).toEqual([
      "#aaaaaaaa",
      "#bbbbbbbb",
      "#cccccccc",
    ]);
    expect(result.suggestedFollowUps).toEqual(["なぜ広告を止めた?", "失敗から何を学んだ?"]);
    // 会話履歴・根拠ブロックがプロンプトに含まれる
    expect(prompts[0]).toContain("質問: 会社の方針を教えて");
    expect(prompts[0]).toContain("[#bbbbbbbb] type=failure_recipe");
  });

  it("LLM 未注入時は捏造しない根拠一覧フォールバック回答", async () => {
    const persona = await makePersona();
    const result = await persona.answer({ tenantId: TENANT, question: "方針は?" });
    expect(result.answer).toContain("3 件の関連記録が見つかりました");
    expect(result.answer).toContain("[#aaaaaaaa]");
    expect(result.suggestedFollowUps.length).toBeGreaterThan(0);
  });

  it("記録ゼロなら正直に「記録が無い」と答える", async () => {
    const memory = new InstitutionalMemoryService({ store: new InMemoryMemoryStore() });
    const persona = new OnboardingPersonaService({ memory });
    const result = await persona.answer({ tenantId: TENANT, question: "方針は?" });
    expect(result.answer).toContain("十分な記録が無い");
    expect(result.citations).toEqual([]);
    expect(result.evidenceCounts).toEqual({
      decision_log: 0,
      failure_recipe: 0,
      success_recipe: 0,
    });
  });

  it("入力バリデーション: 空質問・長すぎる質問・不正な履歴", async () => {
    const persona = await makePersona();
    await expect(persona.answer({ tenantId: TENANT, question: "" })).rejects.toThrow(
      DecisionMemoryValidationError,
    );
    await expect(
      persona.answer({ tenantId: TENANT, question: "q".repeat(2001) }),
    ).rejects.toThrow(/exceeds 2000/);
    await expect(
      persona.answer({
        tenantId: TENANT,
        question: "ok",
        conversationHistory: [{ role: "system" as never, content: "x" }],
      }),
    ).rejects.toThrow(/role must be/);
  });

  it("LLM 失敗時はフォールバック回答に degrade する", async () => {
    const persona = await makePersona(async () => {
      throw new Error("llm down");
    });
    const result = await persona.answer({ tenantId: TENANT, question: "方針は?" });
    expect(result.answer).toContain("AI 要約は現在無効化されている");
  });
});

describe("extractFollowUps", () => {
  it("末尾の「次に聞くと良い質問」ブロックから箇条書きを最大 4 件取り出す", () => {
    const answer =
      "本文 [#12345678]\n\n### 次に聞くと良い質問\n- 質問1\n・質問2\n- 質問3\n- 質問4\n- 質問5";
    expect(extractFollowUps(answer)).toEqual(["質問1", "質問2", "質問3", "質問4"]);
  });

  it("マーカーが無ければ空配列", () => {
    expect(extractFollowUps("マーカーなしの回答")).toEqual([]);
  });
});
