import { describe, expect, it } from "vitest";
import {
  HypothesisDraftError,
  buildWarningToHypothesisPrompt,
  draftHypothesis,
} from "./hypothesis-drafter";
import { longText, queueLlm } from "./test-helpers";

function validDraft() {
  return {
    title: "タイトル",
    summary: "概要",
    hypothesis: longText("仮説"),
    assumption: longText("前提"),
    testPlan: longText("検証"),
    invalidationCriteria: longText("破棄"),
  };
}

describe("draftHypothesis", () => {
  it("有効なドラフトを 1 回で返す", async () => {
    const llm = queueLlm([validDraft()]);
    const { draft, elapsedMs } = await draftHypothesis("context text", llm);
    expect(draft.title).toBe("タイトル");
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
    expect(llm.calls).toHaveLength(1);
  });

  it("バリデーション不合格ならエラー内容を添えて 1 回だけリトライする", async () => {
    const invalid = { ...validDraft(), hypothesis: "短すぎ" };
    const llm = queueLlm([invalid, validDraft()]);
    const { draft } = await draftHypothesis("context text", llm);
    expect(draft.hypothesis.length).toBeGreaterThanOrEqual(40);
    expect(llm.calls).toHaveLength(2);
    // リトライプロンプトにエラー情報が含まれる
    expect(llm.calls[1]?.user).toContain("バリデーションエラー");
  });

  it("リトライでも不合格なら validation_failed を投げる", async () => {
    const invalid = { ...validDraft(), testPlan: "短い" };
    const llm = queueLlm([invalid, invalid]);
    await expect(draftHypothesis("context", llm)).rejects.toMatchObject({
      name: "HypothesisDraftError",
      kind: "validation_failed",
    });
  });

  it("生成が null なら generation_failed を投げる", async () => {
    const llm = queueLlm([null]);
    await expect(draftHypothesis("context", llm)).rejects.toBeInstanceOf(
      HypothesisDraftError,
    );
  });
});

describe("buildWarningToHypothesisPrompt", () => {
  it("警告の内容と sourceUrl をプロンプトに埋め込む", () => {
    const prompt = buildWarningToHypothesisPrompt({
      stackRef: "stack-abc",
      warningId: "w-1",
      title: "Connection pool exhaustion",
      severity: "high",
      summary: "Pool exhausted under load",
      sourceUrl: "https://docs.example.com/pool",
    });
    expect(prompt).toContain("stack-abc");
    expect(prompt).toContain("Connection pool exhaustion");
    expect(prompt).toContain("https://docs.example.com/pool");
  });
});
