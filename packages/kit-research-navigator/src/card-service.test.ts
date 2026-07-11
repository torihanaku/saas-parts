import { describe, expect, it } from "vitest";
import {
  addLearning,
  createManualCard,
  createStackCard,
  executeCardAction,
  getCardDetail,
  updateCardStatus,
  VALID_TRANSITIONS,
} from "./card-service";
import {
  MemoryActionStore,
  MemoryCardStore,
  MemoryLearningStore,
} from "./memory-stores";
import { stubLlm } from "./test-helpers";
import type { CardServiceDeps, IssueProvider } from "./index";
import type { UseCaseCard } from "./types";

const USER = "user-1";

function makeDeps(overrides: Partial<CardServiceDeps> = {}): CardServiceDeps {
  return {
    cardStore: new MemoryCardStore(),
    actionStore: new MemoryActionStore(),
    learningStore: new MemoryLearningStore(),
    ...overrides,
  };
}

function llmCard(): UseCaseCard {
  return {
    source: {
      kind: "manual",
      title: "Generated title",
      summary: "Generated summary",
      capturedAt: "2026-07-01T00:00:00.000Z",
    },
    tool: { kind: "saas", name: "ToolX" },
    integration: { bridgeType: "manual", notes: "" },
    output: { kind: "internal_note", draftText: "draft body", targetRepo: "org/repo" },
    meta: { importanceScore: 0.5, rationale: "why", generatedBy: "llm", sourceVersion: "v1" },
  };
}

async function seedCard(deps: CardServiceDeps) {
  const result = await createManualCard(
    USER,
    { rawInput: "test" },
    { ...deps, llm: stubLlm({ json: llmCard() }) },
  );
  if (!result.ok) throw new Error("seed failed");
  return result.card;
}

describe("createManualCard / createStackCard", () => {
  it("LLM 生成カードを draft で保存する", async () => {
    const deps = makeDeps({ llm: stubLlm({ json: llmCard() }) });
    const result = await createManualCard(USER, { rawInput: "input" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.card.status).toBe("draft");
      expect(result.card.title).toBe("Generated title");
      expect(result.card.triggerSource).toBe("manual");
    }
  });

  it("LLM 未注入なら llm_missing", async () => {
    const result = await createManualCard(USER, { rawInput: "x" }, makeDeps());
    expect(result).toMatchObject({ ok: false, error: "llm_missing" });
  });

  it("stack カードは LLM 不要で決定的に作成する", async () => {
    const result = await createStackCard(
      USER,
      { triggerStackId: "st-1", title: "Adopt X", summary: "sum", hypothesis: "H" },
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.card.triggerSource).toBe("stack");
      expect(result.card.triggerStackId).toBe("st-1");
      expect(result.card.cardData.source.kind).toBe("stack_advice");
    }
  });

  it("stack カードは title/summary 必須", async () => {
    const result = await createStackCard(
      USER,
      { triggerStackId: "st-1", title: "  ", summary: "s" },
      makeDeps(),
    );
    expect(result).toMatchObject({ ok: false, error: "validation" });
  });
});

describe("updateCardStatus", () => {
  it("正当な遷移を許可し learning を自動記録する", async () => {
    const deps = makeDeps();
    const card = await seedCard(deps);

    const r1 = await updateCardStatus(USER, card.id, "testing", "start test", deps);
    expect(r1.ok).toBe(true);
    const r2 = await updateCardStatus(USER, card.id, "validated", undefined, deps);
    expect(r2.ok).toBe(true);

    const learnings = await deps.learningStore.listByCard(USER, card.id);
    expect(learnings).toHaveLength(2);
    expect(learnings.map((l) => l.outcome)).toContain("validated");
    expect(learnings.some((l) => l.learning.includes("draft -> testing: start test"))).toBe(true);
  });

  it("遷移表にない遷移は invalid_transition", async () => {
    const deps = makeDeps();
    const card = await seedCard(deps);
    const result = await updateCardStatus(USER, card.id, "validated", undefined, deps);
    expect(result).toMatchObject({ ok: false, error: "invalid_transition" });
  });

  it("validated / rejected は終端 (遷移先なし)", () => {
    expect(VALID_TRANSITIONS.validated).toEqual([]);
    expect(VALID_TRANSITIONS.rejected).toEqual([]);
  });

  it("存在しないカードは not_found", async () => {
    const deps = makeDeps();
    const result = await updateCardStatus(USER, "nope", "testing", undefined, deps);
    expect(result).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("addLearning", () => {
  it("5〜500 文字の learning を保存する", async () => {
    const deps = makeDeps();
    const card = await seedCard(deps);
    const result = await addLearning(
      USER,
      card.id,
      { learning: "計測の結果、導入コストが想定の2倍だった", outcome: "invalidated" },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.learning.outcome).toBe("invalidated");
  });

  it("短すぎる learning は validation エラー", async () => {
    const deps = makeDeps();
    const card = await seedCard(deps);
    const result = await addLearning(USER, card.id, { learning: "abc" }, deps);
    expect(result).toMatchObject({ ok: false, error: "validation" });
  });
});

describe("executeCardAction", () => {
  const issueProvider: IssueProvider = {
    listOpenIssues: async () => [],
    createIssue: async ({ targetRepo }) => ({
      url: `https://issues.example/${targetRepo}/1`,
    }),
  };

  it("issue: 起票して testing に遷移し issueUrl を記録する", async () => {
    const deps = makeDeps({ issueProvider });
    const card = await seedCard(deps);
    const result = await executeCardAction(
      USER,
      card.id,
      { actionType: "issue", payload: {} },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.card.status).toBe("testing");
      expect(result.action.payload.issueUrl).toBe("https://issues.example/org/repo/1");
    }
  });

  it("issue: targetRepo がどこにも無ければ target_repo_required", async () => {
    const deps = makeDeps({ issueProvider, llm: stubLlm({ json: llmCard() }) });
    const card = await seedCard(deps);
    // カード側の targetRepo を消す
    await deps.cardStore.update(USER, card.id, {
      cardData: { ...card.cardData, output: { ...card.cardData.output, targetRepo: undefined } },
    });
    const result = await executeCardAction(
      USER,
      card.id,
      { actionType: "issue", payload: {} },
      deps,
    );
    expect(result).toMatchObject({ ok: false, error: "target_repo_required" });
  });

  it("issue: provider 未注入なら issue_provider_missing", async () => {
    const deps = makeDeps();
    const card = await seedCard(deps);
    const result = await executeCardAction(
      USER,
      card.id,
      { actionType: "issue", payload: { targetRepo: "org/repo" } },
      deps,
    );
    expect(result).toMatchObject({ ok: false, error: "issue_provider_missing" });
  });

  it("social_draft: LLM でドラフトを生成し testing に遷移する", async () => {
    const deps = makeDeps({ llm: stubLlm({ text: "  新ツール試してみた！  " }) });
    const card = await seedCard(deps);
    const result = await executeCardAction(
      USER,
      card.id,
      { actionType: "social_draft", payload: {} },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.payload.finalDraft).toBe("新ツール試してみた！");
      expect(result.card.status).toBe("testing");
    }
  });

  it("reject: reason 必須、あれば rejected に遷移する", async () => {
    const deps = makeDeps();
    const card = await seedCard(deps);

    const noReason = await executeCardAction(
      USER,
      card.id,
      { actionType: "reject", payload: {} },
      deps,
    );
    expect(noReason).toMatchObject({ ok: false, error: "reason_required" });

    const result = await executeCardAction(
      USER,
      card.id,
      { actionType: "reject", payload: { reason: "not relevant" } },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.card.status).toBe("rejected");
  });

  it("saved_for_later: 記録のみでステータスは変わらない", async () => {
    const deps = makeDeps();
    const card = await seedCard(deps);
    const result = await executeCardAction(
      USER,
      card.id,
      { actionType: "saved_for_later", payload: { note: "later" } },
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.card.status).toBe("draft");

    const detail = await getCardDetail(USER, card.id, deps);
    expect(detail.ok).toBe(true);
    if (detail.ok) expect(detail.actions).toHaveLength(1);
  });
});
