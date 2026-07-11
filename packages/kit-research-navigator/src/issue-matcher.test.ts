import { describe, expect, it } from "vitest";
import { linkIssueToCard, suggestRelatedIssues } from "./issue-matcher";
import { MemoryCardStore } from "./memory-stores";
import { stubLlm } from "./test-helpers";
import type { Card, ExternalIssue } from "./types";
import type { IssueProvider } from "./ports";

const USER = "user-1";

const CARD: Card = {
  id: "card-1",
  userId: USER,
  triggerSource: "manual",
  title: "Adopt vector search",
  summary: "Evaluate pgvector",
  hypothesis: "pgvector is enough for our scale",
  status: "draft",
  cardData: {
    source: { kind: "manual", title: "t", summary: "s", capturedAt: "2026-07-01T00:00:00.000Z" },
    tool: { kind: "library", name: "pgvector" },
    integration: { bridgeType: "api", notes: "" },
    output: { kind: "internal_note", draftText: "" },
    meta: { importanceScore: 0.5, rationale: "", generatedBy: "llm", sourceVersion: "v1" },
  },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function provider(issues: ExternalIssue[]): IssueProvider {
  return {
    listOpenIssues: async () => issues,
    createIssue: async () => null,
  };
}

const ISSUES: ExternalIssue[] = [
  { number: 101, title: "Add pgvector support", body: "…", url: "https://x/101", state: "open" },
  { number: 102, title: "Fix login bug", body: "…", url: "https://x/102", state: "open" },
  { number: 103, title: "Vector index tuning", body: "…", url: "https://x/103", state: "open" },
];

describe("suggestRelatedIssues", () => {
  it("スコア閾値で directMatch と関連候補を分類する", async () => {
    const result = await suggestRelatedIssues(
      CARD,
      {
        issueProvider: provider(ISSUES),
        llm: stubLlm({
          text: 'Here are scores: [{"number": 101, "score": 0.9}, {"number": 102, "score": 0.2}, {"number": 103, "score": 0.7}]',
        }),
      },
    );
    expect(result.directMatch?.number).toBe(101);
    expect(result.suggestedIssues.map((i) => i.number)).toEqual([101, 103]);
  });

  it("open issue が無ければ空を返し LLM を呼ばない", async () => {
    let llmCalled = false;
    const result = await suggestRelatedIssues(CARD, {
      issueProvider: provider([]),
      llm: {
        generateJson: async () => null,
        generateText: async () => {
          llmCalled = true;
          return "[]";
        },
      },
    });
    expect(result.suggestedIssues).toEqual([]);
    expect(llmCalled).toBe(false);
  });

  it("LLM 出力がパース不能なら空 (握りつぶさず onWarn 通知)", async () => {
    const warnings: string[] = [];
    const result = await suggestRelatedIssues(
      CARD,
      { issueProvider: provider(ISSUES), llm: stubLlm({ text: "no json here" }) },
      { onWarn: (m) => warnings.push(m) },
    );
    expect(result.suggestedIssues).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("provider が throw しても空を返す", async () => {
    const result = await suggestRelatedIssues(CARD, {
      issueProvider: {
        listOpenIssues: async () => {
          throw new Error("api down");
        },
        createIssue: async () => null,
      },
      llm: stubLlm({ text: "[]" }),
    });
    expect(result.suggestedIssues).toEqual([]);
  });
});

describe("linkIssueToCard", () => {
  it("cardData.meta.linkedIssueNumber を更新する", async () => {
    const cardStore = new MemoryCardStore();
    const card = await cardStore.insert(USER, {
      triggerSource: "manual",
      title: CARD.title,
      summary: CARD.summary,
      cardData: CARD.cardData,
      status: "draft",
    });
    const updated = await linkIssueToCard(USER, card.id, 42, { cardStore });
    expect(updated?.cardData.meta.linkedIssueNumber).toBe(42);
  });

  it("存在しないカードは null", async () => {
    const cardStore = new MemoryCardStore();
    expect(await linkIssueToCard(USER, "nope", 42, { cardStore })).toBeNull();
  });
});
