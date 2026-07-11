import { describe, expect, it } from "vitest";
import {
  BriefingGenerator,
  buildBriefingPrompt,
  fallbackSummary,
  isoWeek,
  periodFor,
  pickKeyItemIds,
  type BriefingInputs,
} from "./briefing-generator";
import {
  InMemoryBriefingStore,
  InMemoryDigestStore,
  InMemoryTaskStore,
} from "./stores";
import { mockLlm } from "./test-helpers";

const emptyInputs: BriefingInputs = { digests: [], tasks: [], plan: null, insights: [] };

describe("periodFor / isoWeek", () => {
  const now = new Date("2026-07-10T12:00:00Z");

  it("daily は 24h、weekly は 7d", () => {
    const daily = periodFor("daily", now);
    expect(daily.end.getTime() - daily.start.getTime()).toBe(24 * 3600 * 1000);
    const weekly = periodFor("weekly", now);
    expect(weekly.end.getTime() - weekly.start.getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it("status_report も 7d", () => {
    const sr = periodFor("status_report", now);
    expect(sr.end.getTime() - sr.start.getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it("isoWeek は ISO 週番号を返す", () => {
    expect(isoWeek(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
    expect(isoWeek(new Date("2026-07-10T00:00:00Z"))).toBe("2026-W28");
  });
});

describe("buildBriefingPrompt", () => {
  it("digest / タスク / プラン / insight を含む", () => {
    const prompt = buildBriefingPrompt("daily", {
      digests: [{ id: "d1", sourceType: "slack", summary: "CTR改善の議論" }],
      tasks: [{ taskText: "LP改修", assigneeHint: "@田中", dueHint: "金曜" }],
      plan: { title: "7月施策", status: "active" },
      insights: [{ label: "DID", detail: "effect=0.12" }],
    });
    expect(prompt).toContain("日次ブリーフィング");
    expect(prompt).toContain("- [slack] CTR改善の議論");
    expect(prompt).toContain("- LP改修 @田中 金曜");
    expect(prompt).toContain("7月施策 (active)");
    expect(prompt).toContain("- DID: effect=0.12");
    expect(prompt).toContain("/cos/ask");
  });

  it("weekly は 600 字・askHint はパラメータ化できる", () => {
    const prompt = buildBriefingPrompt("weekly", emptyInputs, "/assistant/ask");
    expect(prompt).toContain("週次ブリーフィング");
    expect(prompt).toContain("600 字");
    expect(prompt).toContain("/assistant/ask");
    expect(prompt).toContain("- なし");
  });

  it("status_report は上司向けレポート見出し", () => {
    expect(buildBriefingPrompt("status_report", emptyInputs)).toContain(
      "上司向け状況レポートブリーフィング",
    );
  });
});

describe("pickKeyItemIds / fallbackSummary", () => {
  it("上位 5 件の ID を返す", () => {
    const digests = Array.from({ length: 8 }, (_, i) => ({
      id: `d${i}`,
      sourceType: "slack",
      summary: "s",
    }));
    expect(pickKeyItemIds(digests)).toEqual(["d0", "d1", "d2", "d3", "d4"]);
  });

  it("フォールバックは件数と type を含む決定的な文面", () => {
    const text = fallbackSummary("weekly", emptyInputs);
    expect(text).toContain("週次ブリーフィング — AI 要約は利用できませんでした");
    expect(text).toContain("digest 0 件");
  });
});

describe("BriefingGenerator.generate", () => {
  function setup(llmText: string | undefined) {
    const digestStore = new InMemoryDigestStore();
    const taskStore = new InMemoryTaskStore();
    const briefingStore = new InMemoryBriefingStore();
    const generator = new BriefingGenerator({
      digestStore,
      taskStore,
      briefingStore,
      llm: llmText === undefined ? undefined : mockLlm({ generateText: async () => llmText }),
    });
    return { digestStore, taskStore, briefingStore, generator };
  }

  it("LLM 要約 + key item を保存して返す", async () => {
    const { digestStore, briefingStore, generator } = setup("今日の要約です");
    await digestStore.insert({
      tenantId: "t1",
      sourceType: "slack",
      sourcePermalink: "p",
      sourceActor: null,
      rawTextPreview: "raw",
      rawTextTruncated: false,
      summary: "digest 要約",
      tags: [],
      relevanceScore: 0.9,
    });

    const res = await generator.generate("t1", "daily");
    expect(res.summary).toBe("今日の要約です");
    expect(res.keyItemIds).toHaveLength(1);
    expect(briefingStore.briefings[0]).toMatchObject({
      tenantId: "t1",
      briefingType: "daily",
      summaryText: "今日の要約です",
      keyItemsJson: res.keyItemIds,
    });
  });

  it("LLM が空を返しても行は必ず insert される（フォールバック契約）", async () => {
    const { briefingStore, generator } = setup("");
    const res = await generator.generate("t1", "weekly");
    expect(res.summary).toContain("AI 要約は利用できませんでした");
    expect(briefingStore.briefings).toHaveLength(1);
  });

  it("LLM 未注入でもフォールバックを保存する", async () => {
    const { briefingStore, generator } = setup(undefined);
    const res = await generator.generate("t1", "status_report");
    expect(res.summary).toContain("ステータスレポートブリーフィング");
    expect(briefingStore.briefings[0]!.briefingType).toBe("status_report");
  });

  it("contextProvider のプランと insight がプロンプトに乗る", async () => {
    const digestStore = new InMemoryDigestStore();
    const taskStore = new InMemoryTaskStore();
    const briefingStore = new InMemoryBriefingStore();
    let capturedPrompt = "";
    const generator = new BriefingGenerator({
      digestStore,
      taskStore,
      briefingStore,
      llm: mockLlm({
        generateText: async (_s, prompt) => {
          capturedPrompt = prompt;
          return "ok";
        },
      }),
      contextProvider: async () => ({
        plan: { title: "Q3 プラン", status: "draft" },
        insights: [{ label: "MMM", detail: "TV弾力性 0.3" }],
      }),
    });
    await generator.generate("t1", "daily");
    expect(capturedPrompt).toContain("Q3 プラン (draft)");
    expect(capturedPrompt).toContain("- MMM: TV弾力性 0.3");
  });

  it("briefing insert 失敗は throw", async () => {
    const briefingStore = new InMemoryBriefingStore();
    briefingStore.insert = async () => ({ ok: false, error: "db down" });
    const generator = new BriefingGenerator({
      digestStore: new InMemoryDigestStore(),
      taskStore: new InMemoryTaskStore(),
      briefingStore,
    });
    await expect(generator.generate("t1", "daily")).rejects.toThrow(
      "briefing insert failed: db down",
    );
  });
});
