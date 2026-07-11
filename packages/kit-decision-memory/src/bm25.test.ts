import { describe, expect, it } from "vitest";
import { normalizeScores, rankBm25, tokenize } from "./bm25.js";

describe("tokenize", () => {
  it("英数字を単語トークンに分解する（小文字化）", () => {
    expect(tokenize("Facebook Ads ROI_2")).toEqual(["facebook", "ads", "roi_2"]);
  });

  it("CJK 連続文字列を 2-gram に分解する", () => {
    expect(tokenize("広告停止")).toEqual(["広告", "告停", "停止"]);
  });

  it("CJK 1 文字はそのまま 1 トークンになる", () => {
    expect(tokenize("あ")).toEqual(["あ"]);
  });

  it("英数字と CJK の混在を両方トークン化する", () => {
    const tokens = tokenize("Meta広告");
    expect(tokens).toContain("meta");
    expect(tokens).toContain("広告");
  });
});

describe("rankBm25", () => {
  const docs = [
    { id: "a", text: "Facebook 広告を停止した。CPA が高騰したため。" },
    { id: "b", text: "ブログ投稿を週3回に増やした。オーガニック流入を強化するため。" },
    { id: "c", text: "Facebook 広告の予算を増額した。ROAS が好調だったため。" },
  ];

  it("クエリに関連する文書を上位に返す（決定的）", () => {
    const hits = rankBm25(docs, "Facebook 広告 停止");
    expect(hits[0]?.id).toBe("a");
    expect(hits.map((h) => h.id)).not.toContain("b");
  });

  it("同じ入力に対して常に同じ順序を返す", () => {
    const first = rankBm25(docs, "Facebook 広告");
    for (let i = 0; i < 5; i++) {
      expect(rankBm25(docs, "Facebook 広告")).toEqual(first);
    }
  });

  it("topK で件数を制限する", () => {
    const hits = rankBm25(docs, "広告", { topK: 1 });
    expect(hits).toHaveLength(1);
  });

  it("マッチしないクエリ・空クエリは空配列", () => {
    expect(rankBm25(docs, "zzz_nomatch")).toEqual([]);
    expect(rankBm25(docs, "")).toEqual([]);
    expect(rankBm25([], "広告")).toEqual([]);
  });
});

describe("normalizeScores", () => {
  it("最上位を 1.0 とする similarity 互換値に変換する", () => {
    const normalized = normalizeScores([
      { id: "a", score: 4 },
      { id: "b", score: 2 },
    ]);
    expect(normalized).toEqual([
      { id: "a", similarity: 1 },
      { id: "b", similarity: 0.5 },
    ]);
  });

  it("空入力は空配列", () => {
    expect(normalizeScores([])).toEqual([]);
  });
});
