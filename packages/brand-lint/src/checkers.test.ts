import { describe, it, expect, vi } from "vitest";
import { matchForbiddenWords } from "./forbiddenWordMatcher.js";
import { checkTone } from "./toneChecker.js";
import { checkSimilarity } from "./similarityCheck.js";
import { generateQuickFix } from "./quickFixGenerator.js";
import { InMemoryBrandLintStore, type BrandLintStore } from "./stores.js";
import type { BrandViolation, GenerateJson, SimilarityMatch } from "./types.js";

describe("matchForbiddenWords", () => {
  it("flags a literal forbidden word", () => {
    const v = matchForbiddenWords("謹んでご報告申し上げます。", ["謹んで"]);
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("forbidden_word");
    expect(v[0]!.severity).toBe("error");
    expect(v[0]!.matchedText).toBe("謹んで");
    expect(v[0]!.span).toEqual([0, 3]);
  });

  it("supports regex patterns and multiple hits", () => {
    const v = matchForbiddenWords("最安 最速 最強", ["最.{1}"]);
    expect(v.length).toBeGreaterThanOrEqual(3);
  });

  it("ignores empty patterns and invalid regex gracefully", () => {
    expect(matchForbiddenWords("text", [""])).toHaveLength(0);
    expect(matchForbiddenWords("text", ["("])).toHaveLength(0);
  });
});

describe("checkTone", () => {
  it("detects forbidden words and tone violations", async () => {
    const store = new InMemoryBrandLintStore();
    store.setDnaSnapshot("tenant-A", {
      voice: { description: "親しみやすい" },
      tone: { narrativeStyle: "conversational" },
      forbidden_words: ["謹んで"],
    });
    const generateJson: GenerateJson = vi.fn(async () => ({
      violations: [
        {
          type: "voice_mismatch" as const,
          severity: "warning" as const,
          message: "「謹んで」は合いません。",
          matchedText: "謹んで",
          suggestion: "こんにちは！",
        },
      ],
    })) as unknown as GenerateJson;

    const violations = await checkTone("tenant-A", "謹んでご報告申し上げます。", { store, generateJson });
    expect(violations).toHaveLength(2);
    const forbidden = violations.find((v) => v.type === "forbidden_word");
    expect(forbidden?.severity).toBe("error");
    const tone = violations.find((v) => v.type === "voice_mismatch");
    expect(tone?.severity).toBe("warning");
  });

  it("returns 0 violations when everything matches", async () => {
    const store = new InMemoryBrandLintStore();
    store.setDnaSnapshot("tenant-A", { voice: { description: "Professional" }, tone: {}, forbidden_words: ["banned"] });
    const generateJson = vi.fn(async () => ({ violations: [] })) as unknown as GenerateJson;
    const violations = await checkTone("tenant-A", "clean professional message", { store, generateJson });
    expect(violations).toHaveLength(0);
  });

  it("returns empty and skips LLM when no DNA snapshot found", async () => {
    const store = new InMemoryBrandLintStore();
    const generateJson = vi.fn() as unknown as GenerateJson;
    const violations = await checkTone("tenant-B", "Any content", { store, generateJson });
    expect(violations).toHaveLength(0);
    expect(generateJson).not.toHaveBeenCalled();
  });
});

describe("checkSimilarity", () => {
  function storeReturning(matches: SimilarityMatch[] | null, err = false): BrandLintStore {
    const base = new InMemoryBrandLintStore();
    base.matchRejected = async (tenantId: string) => {
      if (err) throw new Error("db error");
      expect(tenantId).toBeTruthy();
      return matches ?? [];
    };
    return base;
  }

  it("detects highly similar rejected submissions", async () => {
    const store = storeReturning([{ id: "r1", similarity: 0.9, rejection_reason: "Too aggressive" }]);
    const v = await checkSimilarity("tenant-A", new Array(1536).fill(0.1), store);
    expect(v).toHaveLength(1);
    expect(v[0]!.type).toBe("tone_mismatch");
    expect(v[0]!.message).toContain("90%");
    expect(v[0]!.message).toContain("Too aggressive");
  });

  it("returns empty on no matches", async () => {
    const store = storeReturning([]);
    expect(await checkSimilarity("tenant-A", [], store)).toHaveLength(0);
  });

  it("returns empty on store error", async () => {
    const store = storeReturning(null, true);
    expect(await checkSimilarity("tenant-A", [], store)).toHaveLength(0);
  });
});

describe("generateQuickFix", () => {
  it("generates a quick fix using the injected LLM", async () => {
    const store = new InMemoryBrandLintStore();
    store.setDnaSnapshot("tenant-A", { voice: { name: "Casual" }, tone: { narrative: "First person" } });
    const generateJson = vi.fn(async () => ({
      before: "謹んで",
      after: "こんにちは！",
      rationale: "ブランドトーンに合わせて修正しました。",
    })) as unknown as GenerateJson;

    const violation: BrandViolation = { type: "voice_mismatch", severity: "error", message: "不適切なトーン", matchedText: "謹んで" };
    const result = await generateQuickFix("tenant-A", violation, "謹んでご報告申し上げます。", { store, generateJson });
    expect(result.before).toBe("謹んで");
    expect(result.after).toBe("こんにちは！");
    expect(result.rationale).toContain("ブランドトーン");
  });

  it("handles LLM failure gracefully", async () => {
    const store = new InMemoryBrandLintStore();
    const generateJson = vi.fn(async () => {
      throw new Error("Claude API Error");
    }) as unknown as GenerateJson;
    const violation: BrandViolation = { type: "forbidden_word", severity: "error", message: "Banned", matchedText: "banned" };
    const result = await generateQuickFix("tenant-A", violation, "some banned word", { store, generateJson });
    expect(result.before).toBe("banned");
    expect(result.rationale).toContain("失敗しました");
  });
});
