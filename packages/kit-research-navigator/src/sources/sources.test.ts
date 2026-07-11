import { describe, expect, it } from "vitest";
import { fetchAllSignals } from "./index";
import { createHackerNewsSource } from "./hackernews";
import { createExaSearchSource } from "./exa";
import { createPerplexityNewsSource, extractJsonArray } from "./perplexity";
import { stubFetch } from "../test-helpers";

const NOW = () => new Date("2026-07-10T00:00:00.000Z");
const CTX = { userId: "user-1" };

describe("createHackerNewsSource", () => {
  it("topstories → item を辿ってシグナル化する", async () => {
    const fetchFn = stubFetch([
      { match: "topstories.json", body: [1, 2, 3] },
      { match: "/item/1.json", body: { title: "Story 1", url: "https://a.example/1" } },
      { match: "/item/2.json", body: { title: "Story 2" } }, // url なし → HN パーマリンク
      { match: "/item/3.json", body: null }, // 壊れた item → スキップ
    ]);
    const source = createHackerNewsSource({ fetchFn, limit: 3, now: NOW });
    const signals = await source.fetch(CTX);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toEqual({
      source: "hackernews",
      url: "https://a.example/1",
      title: "Story 1",
      body: null,
      fetchedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(signals[1]?.url).toBe("https://news.ycombinator.com/item?id=2");
  });

  it("API エラー時は空配列", async () => {
    const source = createHackerNewsSource({
      fetchFn: stubFetch([{ match: "topstories.json", status: 500, body: {} }]),
    });
    expect(await source.fetch(CTX)).toEqual([]);
  });
});

describe("createExaSearchSource", () => {
  it("検索結果をシグナル化する", async () => {
    const fetchFn = stubFetch([
      {
        match: "/search",
        body: {
          results: [
            { title: "Launch A", url: "https://a.example", text: "body A" },
            { title: "Launch B", url: "https://b.example" },
          ],
        },
      },
    ]);
    const source = createExaSearchSource({ apiKey: "test-key", fetchFn, now: NOW });
    const signals = await source.fetch(CTX);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.source).toBe("exa_search");
    expect(signals[0]?.body).toBe("body A");
    expect(signals[1]?.body).toBeNull();
  });
});

describe("createPerplexityNewsSource", () => {
  it("markdown フェンス付き JSON をパースしてシグナル化する", async () => {
    const content =
      '```json\n[{"title": "News 1", "url": "https://n.example/1", "body": "b"}]\n```';
    const fetchFn = stubFetch([
      {
        match: "chat/completions",
        body: { choices: [{ message: { content } }] },
      },
    ]);
    const source = createPerplexityNewsSource({ apiKey: "k", fetchFn, now: NOW });
    const signals = await source.fetch(CTX);
    expect(signals).toEqual([
      {
        source: "news_digest",
        url: "https://n.example/1",
        title: "News 1",
        body: "b",
        fetchedAt: "2026-07-10T00:00:00.000Z",
      },
    ]);
  });

  it("パース不能な応答は空配列", async () => {
    const fetchFn = stubFetch([
      {
        match: "chat/completions",
        body: { choices: [{ message: { content: "sorry, no data" } }] },
      },
    ]);
    const source = createPerplexityNewsSource({ apiKey: "k", fetchFn });
    expect(await source.fetch(CTX)).toEqual([]);
  });
});

describe("extractJsonArray", () => {
  it("生 JSON / ```json フェンス / ``` フェンスに対応する", () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(extractJsonArray('前置き ```json\n[{"a":1}]\n``` 後置き')).toEqual([{ a: 1 }]);
    expect(extractJsonArray('```\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });
});

describe("fetchAllSignals", () => {
  it("複数ソースを集約し、失敗ソースは onSourceError に通知して続行する", async () => {
    const errors: string[] = [];
    const signals = await fetchAllSignals(
      [
        {
          name: "ok",
          fetch: async () => [
            { source: "ok", url: "https://ok.example", title: "t", fetchedAt: "2026-07-10T00:00:00.000Z" },
          ],
        },
        {
          name: "broken",
          fetch: async () => {
            throw new Error("boom");
          },
        },
      ],
      CTX,
      { onSourceError: (name) => errors.push(name) },
    );
    expect(signals).toHaveLength(1);
    expect(errors).toEqual(["broken"]);
  });
});
