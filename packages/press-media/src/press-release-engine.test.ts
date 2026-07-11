/**
 * Tests for press-release-engine (ported from dev-dashboard-v2).
 * LLM は注入式 mock に置換。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  formatPressReleaseAsText,
  generatePressRelease,
  brandCheckPressRelease,
} from "./press-release-engine";
import type { PressReleaseStructure, PRType } from "./press-release-engine";
import type { GenerateJson } from "./llm";

const mockGenerateJson = vi.fn() as unknown as ReturnType<typeof vi.fn> & GenerateJson;

const SAMPLE_STRUCTURE: PressReleaseStructure = {
  title: "テスト製品のリリース",
  subtitle: "次世代AIソリューション",
  lead: "株式会社テストは本日、新製品「テスト製品」の提供を開始しました。",
  body: "本製品は、最新のAI技術を活用しています。\n\n企業の業務効率を大幅に改善します。",
  companyInfo: "株式会社テスト 東京都渋谷区 代表取締役 テスト太郎",
  contact: "広報部 テスト花子 03-1234-5678 pr@test.co.jp",
};

describe("formatPressReleaseAsText", () => {
  it("includes all structure fields in output", () => {
    const text = formatPressReleaseAsText(SAMPLE_STRUCTURE);
    expect(text).toContain(SAMPLE_STRUCTURE.title);
    expect(text).toContain(SAMPLE_STRUCTURE.subtitle);
    expect(text).toContain(SAMPLE_STRUCTURE.lead);
    expect(text).toContain(SAMPLE_STRUCTURE.body);
    expect(text).toContain(SAMPLE_STRUCTURE.companyInfo);
    expect(text).toContain(SAMPLE_STRUCTURE.contact);
  });

  it("includes section headers", () => {
    const text = formatPressReleaseAsText(SAMPLE_STRUCTURE);
    expect(text).toContain("【プレスリリース】");
    expect(text).toContain("【会社概要】");
    expect(text).toContain("【お問い合わせ先】");
  });

  it("prefixes subtitle with a dash", () => {
    const text = formatPressReleaseAsText(SAMPLE_STRUCTURE);
    expect(text).toContain(`― ${SAMPLE_STRUCTURE.subtitle}`);
  });

  it("omits empty fields gracefully", () => {
    const sparse: PressReleaseStructure = {
      title: "タイトルのみ",
      subtitle: "",
      lead: "",
      body: "",
      companyInfo: "",
      contact: "",
    };
    const text = formatPressReleaseAsText(sparse);
    expect(text).toContain("タイトルのみ");
    expect(text).not.toContain("【会社概要】");
    expect(text).not.toContain("【お問い合わせ先】");
  });
});

describe("PR_TYPE coverage", () => {
  const allTypes: PRType[] = ["new_product", "event", "earnings", "partnership", "other"];

  it.each(allTypes)('generatePressRelease accepts prType "%s"', async (prType) => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...SAMPLE_STRUCTURE });
    const result = await generatePressRelease(mockGenerateJson, "test-key", { topic: "テスト", prType });
    expect(result.title).toBe(SAMPLE_STRUCTURE.title);
  });
});

describe("generatePressRelease", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the structure from generateJson", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...SAMPLE_STRUCTURE });
    const result = await generatePressRelease(mockGenerateJson, "test-key", {
      topic: "新製品リリース",
      prType: "new_product",
    });
    expect(result.title).toBe(SAMPLE_STRUCTURE.title);
    expect(result.lead).toBe(SAMPLE_STRUCTURE.lead);
  });

  it("returns empty structure when title and lead are both empty", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      title: "",
      subtitle: "",
      lead: "",
      body: "",
      companyInfo: "",
      contact: "",
    });
    const result = await generatePressRelease(mockGenerateJson, "test-key", {
      topic: "テスト",
      prType: "other",
    });
    expect(result.title).toBe("");
    expect(result.lead).toBe("");
  });

  it("passes context in user prompt when provided", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...SAMPLE_STRUCTURE });
    await generatePressRelease(mockGenerateJson, "test-key", {
      topic: "テスト",
      prType: "event",
      context: "2026年5月開催",
    });
    const [, , userPrompt] = (mockGenerateJson as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(userPrompt).toContain("2026年5月開催");
  });
});

describe("brandCheckPressRelease", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns passed result when score >= 80", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      passed: true,
      violations: [],
      score: 92,
    });
    const result = await brandCheckPressRelease(mockGenerateJson, "test-key", SAMPLE_STRUCTURE, "フォーマルなトーンで統一");
    expect(result.passed).toBe(true);
    expect(result.score).toBe(92);
    expect(result.violations).toEqual([]);
  });

  it("returns failed result when score < 80", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      passed: false,
      violations: ["カジュアルすぎる表現が含まれています"],
      score: 55,
    });
    const result = await brandCheckPressRelease(mockGenerateJson, "test-key", SAMPLE_STRUCTURE, "フォーマルなトーンで統一");
    expect(result.passed).toBe(false);
    expect(result.score).toBe(55);
    expect(result.violations).toHaveLength(1);
  });

  it("clamps score to 0-100 range and re-evaluates passed", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      passed: true,
      violations: [],
      score: 150,
    });
    const result = await brandCheckPressRelease(mockGenerateJson, "test-key", SAMPLE_STRUCTURE, "ガイドライン");
    expect(result.score).toBe(100);
    expect(result.passed).toBe(true);
  });

  it("sets passed=false when clamped score is below 80", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      passed: true,
      violations: [],
      score: -10,
    });
    const result = await brandCheckPressRelease(mockGenerateJson, "test-key", SAMPLE_STRUCTURE, "ガイドライン");
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });
});
