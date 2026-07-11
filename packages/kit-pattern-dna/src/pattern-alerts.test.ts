/**
 * 出典テスト: dev-dashboard-v2 tests/company-dna-pattern-alerts.test.ts
 * （lib 部分のコアを移植。route 層のゲーティングは HTTP 配線ごと落とした）。
 */
import { describe, it, expect } from "vitest";
import {
  FAILURE_OUTCOMES,
  SUCCESS_OUTCOMES,
  checkPatternAlerts,
  classifyOutcome,
  extractRowText,
  jaccardSimilarity,
  tokenize,
} from "./pattern-alerts.js";
import { InMemoryDnaStore } from "./stores.js";
import type { PatternDnaType } from "./types.js";

const TENANT = "tenant-1";

describe("classifyOutcome", () => {
  it("returns 'failure' for known failure outcomes (case + whitespace tolerant)", () => {
    for (const v of FAILURE_OUTCOMES) {
      expect(classifyOutcome({ outcome: v })).toBe("failure");
      expect(classifyOutcome({ outcome: `  ${v.toUpperCase()}  ` })).toBe("failure");
    }
  });

  it("returns 'success' for known success outcomes", () => {
    for (const v of SUCCESS_OUTCOMES) {
      expect(classifyOutcome({ outcome: v })).toBe("success");
    }
  });

  it("falls back to value.status / value.result", () => {
    expect(classifyOutcome({ status: "rejected" })).toBe("failure");
    expect(classifyOutcome({ result: "approved" })).toBe("success");
  });

  it("returns 'neutral' for missing / non-object / unknown outcomes", () => {
    expect(classifyOutcome(null)).toBe("neutral");
    expect(classifyOutcome(undefined)).toBe("neutral");
    expect(classifyOutcome("just-a-string")).toBe("neutral");
    expect(classifyOutcome({})).toBe("neutral");
    expect(classifyOutcome({ outcome: "maybe" })).toBe("neutral");
    expect(classifyOutcome({ outcome: 42 })).toBe("neutral");
  });
});

describe("tokenize", () => {
  it("returns empty set for empty / non-string input", () => {
    expect(tokenize("").size).toBe(0);
    expect(tokenize(null).size).toBe(0);
    expect(tokenize(undefined).size).toBe(0);
    expect(tokenize(42).size).toBe(0);
  });

  it("lowercases, splits on punctuation, drops short tokens + stopwords", () => {
    const out = tokenize("The Quick brown fox, JUMPS! over the lazy dog.");
    expect(out.has("quick")).toBe(true);
    expect(out.has("jumps")).toBe(true);
    expect(out.has("the")).toBe(false); // stopword
    expect(tokenize("a I b c d quick").has("quick")).toBe(true);
    expect(tokenize("a I b c d quick").size).toBe(1); // 1 文字トークンは落ちる
  });

  it("drops Japanese particles", () => {
    const out = tokenize("新製品 の 発表 は 明日 です");
    expect(out.has("新製品")).toBe(true);
    expect(out.has("発表")).toBe(true);
    expect(out.has("の")).toBe(false);
    expect(out.has("です")).toBe(false);
  });
});

describe("jaccardSimilarity", () => {
  it("is 1 for identical sets, 0 for disjoint / empty sets", () => {
    const a = new Set(["x", "y"]);
    expect(jaccardSimilarity(a, new Set(["x", "y"]))).toBe(1);
    expect(jaccardSimilarity(a, new Set(["z"]))).toBe(0);
    expect(jaccardSimilarity(a, new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("computes intersection / union", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(2 / 4, 10);
  });
});

describe("extractRowText", () => {
  it("prefers text > body > summary > description > title", () => {
    expect(extractRowText({ text: "T", title: "X" })).toBe("T");
    expect(extractRowText({ body: "B", summary: "S" })).toBe("B");
    expect(extractRowText({ summary: "S", title: "X" })).toBe("S");
    expect(extractRowText({ title: "X" })).toBe("X");
  });

  it("returns '' for non-object / missing fields", () => {
    expect(extractRowText(null)).toBe("");
    expect(extractRowText("str")).toBe("");
    expect(extractRowText({ other: 1 })).toBe("");
  });
});

describe("checkPatternAlerts", () => {
  async function seed(store: InMemoryDnaStore) {
    const rows: Array<{
      dnaType: PatternDnaType;
      key: string;
      value: Record<string, unknown>;
      confidence?: number;
    }> = [
      {
        dnaType: "content",
        key: "fail-1",
        value: { outcome: "failure", text: "価格改定のお知らせ 値上げ 告知 メール" },
        confidence: 0.9,
      },
      {
        dnaType: "content",
        key: "win-1",
        value: { outcome: "success", text: "価格改定のお知らせ 事例 紹介 メール" },
        confidence: 0.8,
      },
      {
        dnaType: "content",
        key: "neutral-1",
        value: { text: "価格改定のお知らせ" }, // outcome なし → neutral
      },
      {
        dnaType: "glossary",
        key: "no-text",
        value: { outcome: "failure" }, // テキストなし → スキップ
      },
      {
        dnaType: "seasonal",
        key: "far",
        value: { outcome: "failure", text: "全く 関係ない 話題 猫 写真" },
      },
    ];
    for (const r of rows) {
      await store.upsert({
        tenantId: TENANT,
        dnaType: r.dnaType,
        key: r.key,
        value: r.value,
        source: "manual",
        confidence: r.confidence ?? 1,
      });
    }
  }

  it("returns a well-shaped empty result on missing input", async () => {
    const store = new InMemoryDnaStore();
    const empty = await checkPatternAlerts(store, { tenantId: "", draftText: "x y z" });
    expect(empty.failureWarnings).toEqual([]);
    expect(empty.successRecommendations).toEqual([]);
    expect(empty.scanned).toBe(0);

    const empty2 = await checkPatternAlerts(store, { tenantId: TENANT, draftText: "   " });
    expect(empty2.scanned).toBe(0);
  });

  it("splits overlapping rows into failure / success buckets", async () => {
    const store = new InMemoryDnaStore();
    await seed(store);
    const res = await checkPatternAlerts(store, {
      tenantId: TENANT,
      draftText: "価格改定のお知らせ 値上げ メール",
      threshold: 0.2,
    });
    expect(res.scanned).toBe(5);
    expect(res.failureWarnings.map((h) => h.key)).toContain("fail-1");
    expect(res.successRecommendations.map((h) => h.key)).toContain("win-1");
    // 無関係な失敗行はしきい値未達
    expect(res.failureWarnings.map((h) => h.key)).not.toContain("far");
    // neutral / テキストなしは現れない
    const allKeys = [...res.failureWarnings, ...res.successRecommendations].map((h) => h.key);
    expect(allKeys).not.toContain("neutral-1");
    expect(allKeys).not.toContain("no-text");
    // ヒットは類似度降順
    const sims = res.failureWarnings.map((h) => h.similarity);
    expect([...sims].sort((a, b) => b - a)).toEqual(sims);
  });

  it("respects dnaType filter and maxHits clamp", async () => {
    const store = new InMemoryDnaStore();
    await seed(store);
    const res = await checkPatternAlerts(store, {
      tenantId: TENANT,
      draftText: "価格改定のお知らせ 値上げ メール",
      dnaType: "seasonal",
      threshold: 0,
    });
    expect(res.failureWarnings.every((h) => h.dnaType === "seasonal")).toBe(true);
    expect(res.successRecommendations).toEqual([]);

    const clamped = await checkPatternAlerts(store, {
      tenantId: TENANT,
      draftText: "価格改定のお知らせ",
      threshold: 0,
      maxHits: 99, // → 10 にクランプ
    });
    expect(clamped.failureWarnings.length).toBeLessThanOrEqual(10);
  });

  it("never throws on store failure — returns empty result", async () => {
    const failing = new InMemoryDnaStore();
    failing.list = async () => {
      throw new Error("db down");
    };
    const res = await checkPatternAlerts(failing, { tenantId: TENANT, draftText: "hello world" });
    expect(res.failureWarnings).toEqual([]);
    expect(res.scanned).toBe(0);
  });
});
