import { describe, expect, it } from "vitest";
import { extractContacts, HandoffService } from "./handoff.js";
import { InMemoryMemoryStore } from "./stores.js";
import { fixedContext, seedMemories, TENANT } from "./test-helpers.js";
import { DecisionMemoryValidationError } from "./types.js";

async function seededStore(): Promise<InMemoryMemoryStore> {
  const store = new InMemoryMemoryStore();
  await seedMemories(store, [
    {
      id: "aaaaaaaa-1",
      memType: "decision_log",
      subject: "広告停止の決定",
      content: "CPA 高騰のため",
      source: "case-42",
      decidedBy: "田中",
    },
    {
      id: "bbbbbbbb-2",
      memType: "failure_recipe",
      subject: "値引き乱発",
      content: "LTV 悪化",
      source: "case-42",
      decidedBy: "佐藤",
    },
    {
      id: "cccccccc-3",
      memType: "success_recipe",
      subject: "ブログ強化",
      content: "流入 2 倍",
      source: "other-case",
      decidedBy: "鈴木",
    },
  ]);
  return store;
}

describe("HandoffService.buildHandoffSummary", () => {
  it("caseId に紐づく記録だけをバケットし、Markdown と citations を返す", async () => {
    const service = new HandoffService({ store: await seededStore(), context: fixedContext() });
    const result = await service.buildHandoffSummary({
      tenantId: TENANT,
      caseId: "case-42",
      fromUser: "田中",
      toUser: "山田",
    });
    expect(result.hasEvidence).toBe(true);
    expect(result.citations.map((c) => c.id).sort()).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    // ヘッダ（決定的な生成日時）
    expect(result.markdown).toContain("# 引き継ぎサマリ — case-42");
    expect(result.markdown).toContain("- **引き継ぎ先**: 山田");
    expect(result.markdown).toContain("- **生成日時**: 2026-07-01T00:00:00.000Z");
    // mem_type 別バケット（成功レシピは記録なし）
    expect(result.markdown).toContain("### 決定事項");
    expect(result.markdown).toContain("`[#aaaaaaaa]` **広告停止の決定**");
    expect(result.markdown).toContain("### 失敗 / 注意点");
    expect(result.markdown).toContain("### 成功 / 効いた施策\n- （該当する記録なし）");
    // 連絡先
    expect(result.markdown).toContain("## 主要連絡先");
    expect(result.markdown).toContain("- 佐藤");
    // 他案件（other-case）は混入しない
    expect(result.markdown).not.toContain("ブログ強化");
    // LLM 未注入の degrade メッセージ
    expect(result.markdown).toContain("_AI 要約は利用できません");
  });

  it("generateText 注入時は根拠付きプロンプトでナラティブを生成し本文に含める", async () => {
    const prompts: string[] = [];
    const service = new HandoffService({
      store: await seededStore(),
      context: fixedContext(),
      generateText: async (_system, user) => {
        prompts.push(user);
        return "## 決定事項\n広告を止めました [#aaaaaaaa]";
      },
    });
    const result = await service.buildHandoffSummary({
      tenantId: TENANT,
      caseId: "case-42",
      fromUser: "田中",
    });
    expect(result.markdown).toContain("## AI による要約\n## 決定事項\n広告を止めました");
    expect(prompts[0]).toContain("案件 (caseId): case-42");
    expect(prompts[0]).toContain("引き継ぎ先: 未確定");
    expect(prompts[0]).toContain("- 田中");
  });

  it("LLM 失敗時は骨格 Markdown に degrade する", async () => {
    const service = new HandoffService({
      store: await seededStore(),
      context: fixedContext(),
      generateText: async () => {
        throw new Error("llm down");
      },
    });
    const result = await service.buildHandoffSummary({
      tenantId: TENANT,
      caseId: "case-42",
      fromUser: "田中",
    });
    expect(result.hasEvidence).toBe(true);
    expect(result.markdown).toContain("_AI 要約は利用できません");
  });

  it("記録ゼロの案件は空スケルトンと hasEvidence=false", async () => {
    const service = new HandoffService({ store: await seededStore(), context: fixedContext() });
    const result = await service.buildHandoffSummary({
      tenantId: TENANT,
      caseId: "unknown-case",
      fromUser: "田中",
    });
    expect(result.hasEvidence).toBe(false);
    expect(result.citations).toEqual([]);
    expect(result.markdown).toContain("紐づく記録がありません");
  });

  it("バリデーション: tenantId / caseId / fromUser 必須", async () => {
    const service = new HandoffService({ store: new InMemoryMemoryStore() });
    await expect(
      service.buildHandoffSummary({ tenantId: "", caseId: "c", fromUser: "f" }),
    ).rejects.toThrow(DecisionMemoryValidationError);
    await expect(
      service.buildHandoffSummary({ tenantId: TENANT, caseId: " ", fromUser: "f" }),
    ).rejects.toThrow("caseId is required");
    await expect(
      service.buildHandoffSummary({ tenantId: TENANT, caseId: "c", fromUser: "" }),
    ).rejects.toThrow("fromUser is required");
  });
});

describe("extractContacts", () => {
  it("decidedBy を重複排除して返す（空はスキップ）", async () => {
    const store = await seededStore();
    const rows = await store.listByTenant(TENANT);
    expect(extractContacts(rows).sort()).toEqual(["佐藤", "田中", "鈴木"]);
    expect(extractContacts([])).toEqual([]);
  });
});
