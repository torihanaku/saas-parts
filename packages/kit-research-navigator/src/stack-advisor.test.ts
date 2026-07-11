import { describe, expect, it } from "vitest";
import { generateStackRecommendation } from "./stack-advisor";
import { MemoryStackStore } from "./memory-stores";
import { stubLlm } from "./test-helpers";
import type { Stack } from "./types";

const INPUT = { currentStack: "SQLite", scale: "100 users", pains: "同時書き込み" };

function stack(slug: string, name: string): Stack {
  return {
    id: `id-${slug}`,
    slug,
    category: "db",
    name,
    vendor: `${name} Inc.`,
    description: `${name} description`,
    pricingUrl: `https://${slug}.example/pricing`,
    docsUrl: `https://${slug}.example/docs`,
    pros: ["fast"],
    cons: ["cost"],
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeStore(): MemoryStackStore {
  const store = new MemoryStackStore();
  // クエリ埋め込み [1,0,0] に対する決定的な類似度
  store.addStack(stack("postgres", "Postgres"), [1, 0, 0]); // sim 1.0
  store.addStack(stack("mysql", "MySQL"), [0.9, 0.1, 0]); // sim ~0.99
  store.addStack(stack("mongo", "Mongo"), [0, 0, 1]); // sim 0 → 閾値未満
  return store;
}

const embedder = async () => [1, 0, 0];

const llmOk = stubLlm({
  json: {
    primarySlug: "postgres",
    primaryReasons: ["relational fit"],
    migrationEffortDays: 3,
    alternativeSlug: "mysql",
    alternativeReasons: ["cheaper"],
    warnings: [
      {
        title: "Connection limits",
        summary: "Pool exhaustion under load",
        sourceUrl: "https://postgres.example/warn",
        severity: "high",
      },
    ],
  },
});

describe("generateStackRecommendation", () => {
  it("候補から primary/alternative を解決し warning を付けて返す", async () => {
    const rec = await generateStackRecommendation(INPUT, {
      embedder,
      stackStore: makeStore(),
      llm: llmOk,
      now: () => new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(rec?.primary.stack.slug).toBe("postgres");
    expect(rec?.primary.migrationEffortDays).toBe(3);
    expect(rec?.alternative.stack.slug).toBe("mysql");
    expect(rec?.warnings).toHaveLength(1);
    expect(rec?.warnings[0]?.severity).toBe("high");
    // checkUrls 省略時は全 URL 到達可能扱い
    expect(rec?.docs).toEqual([
      "https://postgres.example/docs",
      "https://postgres.example/pricing",
    ]);
  });

  it("checkUrls で到達不能な docs / warning URL を落とす", async () => {
    const rec = await generateStackRecommendation(INPUT, {
      embedder,
      stackStore: makeStore(),
      llm: llmOk,
      checkUrls: async (urls) =>
        urls.filter((u) => u === "https://postgres.example/docs"),
    });
    expect(rec?.docs).toEqual(["https://postgres.example/docs"]);
    expect(rec?.warnings[0]?.sourceUrl).toBeUndefined();
  });

  it("LLM が候補外の slug を返したら null (幻覚ガード)", async () => {
    const rec = await generateStackRecommendation(INPUT, {
      embedder,
      stackStore: makeStore(),
      llm: stubLlm({ json: { primarySlug: "oracle", primaryReasons: [] } }),
    });
    expect(rec).toBeNull();
  });

  it("候補が 2 件未満なら LLM を呼ばず null", async () => {
    const store = new MemoryStackStore();
    store.addStack(stack("postgres", "Postgres"), [1, 0, 0]);
    let llmCalled = false;
    const rec = await generateStackRecommendation(INPUT, {
      embedder,
      stackStore: store,
      llm: {
        generateJson: async () => {
          llmCalled = true;
          return null;
        },
        generateText: async () => "",
      },
    });
    expect(rec).toBeNull();
    expect(llmCalled).toBe(false);
  });

  it("埋め込みプロバイダ障害は null に落とす", async () => {
    const rec = await generateStackRecommendation(INPUT, {
      embedder: async () => {
        throw new Error("provider down");
      },
      stackStore: makeStore(),
      llm: llmOk,
    });
    expect(rec).toBeNull();
  });

  it("alternative が無ければ primary を再掲し明示理由を付す", async () => {
    const rec = await generateStackRecommendation(INPUT, {
      embedder,
      stackStore: makeStore(),
      llm: stubLlm({
        json: { primarySlug: "postgres", primaryReasons: ["fit"] },
      }),
    });
    expect(rec?.alternative.stack.slug).toBe("postgres");
    expect(rec?.alternative.reasons).toEqual([
      "no viable alternative in shortlist",
    ]);
  });
});
