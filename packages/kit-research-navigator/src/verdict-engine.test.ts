import { describe, expect, it } from "vitest";
import { judgeVerdict } from "./verdict-engine";
import { MemorySignalStore } from "./memory-stores";
import { stubLlm } from "./test-helpers";
import type { Signal } from "./types";

const USER = "user-1";

function makeSignal(id: string, title: string): Signal {
  return {
    id,
    userId: USER,
    source: "test",
    url: `https://example.com/${id}`,
    title,
    body: null,
    fetchedAt: "2026-07-01T00:00:00.000Z",
    seenAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("judgeVerdict", () => {
  it("LLM 出力をそのまま verdict として返す", async () => {
    const result = await judgeVerdict(makeSignal("s1", "AI launch"), "ctx", {
      llm: stubLlm({
        json: { verdict: "big_deal", rationale: "matters", importance_score: 88 },
      }),
      signalStore: new MemorySignalStore(),
    });
    expect(result.verdict).toBe("big_deal");
    expect(result.importanceScore).toBe(88);
    expect(result.relatedSignalIds).toEqual([]);
  });

  it("LLM が null / 不正な形を返したら meh にフォールバックする", async () => {
    const store = new MemorySignalStore();
    for (const bad of [null, { verdict: "amazing", rationale: 1 }, { verdict: "big_deal" }]) {
      const result = await judgeVerdict(makeSignal("s1", "t"), "ctx", {
        llm: stubLlm({ json: bad }),
        signalStore: store,
      });
      expect(result.verdict).toBe("meh");
      expect(result.importanceScore).toBe(0);
    }
  });

  it("LLM が throw しても meh にフォールバックする", async () => {
    const warnings: string[] = [];
    const result = await judgeVerdict(makeSignal("s1", "t"), "ctx", {
      llm: {
        generateJson: async () => {
          throw new Error("api down");
        },
        generateText: async () => "",
      },
      signalStore: new MemorySignalStore(),
      onWarn: (m) => warnings.push(m),
    });
    expect(result.verdict).toBe("meh");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("埋め込み注入時は類似シグナルを関連付け、自分自身は除外する", async () => {
    const store = new MemorySignalStore();
    const sigA = await store.insert(USER, {
      source: "test",
      url: "https://example.com/a",
      title: "Vector DB pricing change",
      fetchedAt: "2026-07-01T00:00:00.000Z",
    });
    const sigB = await store.insert(USER, {
      source: "test",
      url: "https://example.com/b",
      title: "Unrelated cooking recipe",
      fetchedAt: "2026-07-01T00:00:00.000Z",
    });
    await store.saveEmbedding(sigA!.id, [1, 0, 0]);
    await store.saveEmbedding(sigB!.id, [0, 1, 0]);

    const target = await store.insert(USER, {
      source: "test",
      url: "https://example.com/c",
      title: "Vector DB new release",
      fetchedAt: "2026-07-01T00:00:00.000Z",
    });

    const result = await judgeVerdict(target!, "ctx", {
      llm: stubLlm({
        json: { verdict: "worth_watching", rationale: "r", importance_score: 50 },
      }),
      embedder: async () => [0.99, 0.01, 0],
      signalStore: store,
      matchThreshold: 0.9,
    });

    expect(result.relatedSignalIds).toContain(sigA!.id);
    expect(result.relatedSignalIds).not.toContain(sigB!.id);
    expect(result.relatedSignalIds).not.toContain(target!.id);
  });
});
