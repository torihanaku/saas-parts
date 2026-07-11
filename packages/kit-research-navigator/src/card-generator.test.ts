import { describe, expect, it } from "vitest";
import { buildStackAdvisorCard, generateManualCard } from "./card-generator";
import { queueLlm } from "./test-helpers";
import type { UseCaseCard } from "./types";

function validCard(): UseCaseCard {
  return {
    source: {
      kind: "manual",
      title: "New workflow tool",
      summary: "Automation opportunity",
      capturedAt: "2026-07-01T00:00:00.000Z",
    },
    tool: { kind: "saas", name: "ToolX" },
    integration: { bridgeType: "api", notes: "REST API" },
    output: { kind: "internal_note", draftText: "Try ToolX for our workflow" },
    meta: {
      importanceScore: 0.8,
      rationale: "Saves time",
      generatedBy: "llm",
      sourceVersion: "v1",
    },
  };
}

describe("generateManualCard", () => {
  it("スキーマ準拠のカードを返す", async () => {
    const llm = queueLlm([validCard()]);
    const card = await generateManualCard("raw input", "", llm);
    expect(card?.tool.name).toBe("ToolX");
    expect(llm.calls).toHaveLength(1);
  });

  it("スキーマ違反なら 1 回リトライし、成功すればそれを返す", async () => {
    const invalid = { ...validCard(), meta: { ...validCard().meta, importanceScore: 5 } };
    const llm = queueLlm([invalid, validCard()]);
    const card = await generateManualCard("raw input", "ctx", llm);
    expect(card?.meta.importanceScore).toBe(0.8);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.user).toContain("前の出力はエラーでした");
  });

  it("リトライも失敗したら null", async () => {
    const invalid = { bad: true };
    const llm = queueLlm([invalid, invalid]);
    const card = await generateManualCard("raw input", "", llm);
    expect(card).toBeNull();
  });

  it("LLM が throw したら null", async () => {
    const card = await generateManualCard("raw", "", {
      generateJson: async () => {
        throw new Error("down");
      },
      generateText: async () => "",
    });
    expect(card).toBeNull();
  });
});

describe("buildStackAdvisorCard", () => {
  const now = () => new Date("2026-07-01T00:00:00.000Z");

  it("仮説フィールドを draftText に決定的に組み立てる", () => {
    const card = buildStackAdvisorCard(
      {
        triggerStackId: "stack-1",
        title: "Move to Postgres",
        summary: "Better relational fit",
        hypothesis: "H",
        testPlan: "T",
      },
      now,
    );
    expect(card.source.kind).toBe("stack_advice");
    expect(card.source.capturedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(card.output.draftText).toBe("Hypothesis: H\nTest plan: T");
    expect(card.integration.notes).toContain("stack-1");
  });

  it("仮説フィールドが無ければ summary を draftText に使う", () => {
    const card = buildStackAdvisorCard(
      { triggerStackId: "s", title: "T", summary: "S only" },
      now,
    );
    expect(card.output.draftText).toBe("S only");
  });
});
