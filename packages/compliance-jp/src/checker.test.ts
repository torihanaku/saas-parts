/**
 * Ported from 実運用SaaS
 * `tests/server/lib/compliance/checker-service.test.ts`.
 * Supabase / tenant-secret / Claude mocks replaced by explicit rules and the
 * injected LLM callback + store.
 */
import { describe, it, expect, vi } from "vitest";

import { check, type LlmCheckFn } from "./checker";
import { createRuleRegistry } from "./rules/index";
import type { JpLawRule } from "./types";

const keywordRule: JpLawRule = {
  id: "r1",
  lawCode: "keihyo",
  ruleKey: "sure_profit",
  patternType: "keyword",
  pattern: JSON.stringify(["絶対儲かる"]),
  severity: "error",
  descriptionJa: "断定的利益表現",
};

const regexRule: JpLawRule = {
  id: "r2",
  lawCode: "keihyo",
  ruleKey: "lowest_price_regex",
  patternType: "regex",
  pattern: "最[安低]値",
  severity: "warning",
  descriptionJa: "最安値表現",
};

describe("Compliance Checker Service", () => {
  it("matches regex and keyword patterns and calculates risk score correctly", async () => {
    const saveCheck = vi.fn().mockResolvedValue("check-1");
    const result = await check({
      text: "この商品は業界最安値で、絶対儲かる仕組みです。",
      rules: [keywordRule, regexRule],
      store: { saveCheck },
    });

    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.matchedText)).toContain("絶対儲かる");
    expect(result.violations.map((v) => v.matchedText)).toContain("最安値");
    // error: 40, warning: 15 -> total 55
    expect(result.riskScore).toBe(55);
    expect(result.checkId).toBe("check-1");
    expect(saveCheck).toHaveBeenCalledWith(
      expect.objectContaining({ riskScore: 55 }),
    );
  });

  it("handles LLM rules and continues on error", async () => {
    const llmRules: JpLawRule[] = [
      {
        id: "llm1",
        lawCode: "keihyo",
        ruleKey: "exaggerated",
        patternType: "llm_prompt",
        pattern: "Find exaggerated claims",
        severity: "error",
        descriptionJa: "誇大表現",
      },
      {
        id: "llm2",
        lawCode: "keihyo",
        ruleKey: "missing_disclaimer",
        patternType: "llm_prompt",
        pattern: "Find missing disclaimer",
        severity: "warning",
        descriptionJa: "免責表示欠如",
      },
    ];
    const llmCheck: LlmCheckFn = vi
      .fn()
      .mockResolvedValueOnce({ violated: true, matched_text: "amazing", span: [0, 7] })
      .mockImplementationOnce(() => {
        throw new Error("LLM failure");
      });

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await check({
      text: "amazing product",
      rules: llmRules,
      llmCheck,
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.matchedText).toBe("amazing");
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("llm_check_rule_failed"));
    expect(result.riskScore).toBe(40);

    consoleWarnSpy.mockRestore();
  });

  it("skips llm_prompt rules with a warning when no callback is injected", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await check({
      text: "amazing product",
      rules: [
        {
          id: "llm1",
          lawCode: "keihyo",
          ruleKey: "exaggerated",
          patternType: "llm_prompt",
          pattern: "Find exaggerated claims",
          severity: "error",
          descriptionJa: "誇大表現",
        },
      ],
    });
    expect(result.violations).toHaveLength(0);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("llm_check_skipped_no_callback"),
    );
    consoleWarnSpy.mockRestore();
  });

  it("caps riskScore at 100 and returns the Japanese no-risk summary on clean text", async () => {
    const dirty = await check({
      text: "絶対儲かる。絶対儲かる。絶対儲かる。",
      rules: [keywordRule],
    });
    expect(dirty.riskScore).toBe(100);

    const clean = await check({ text: "通常の商品説明です。", rules: [keywordRule] });
    expect(clean.riskScore).toBe(0);
    expect(clean.summary).toBe("コンプライアンス上のリスクは検出されませんでした。");
    expect(clean.checkId).toBeNull();
  });

  it("uses the bundled 50-rule library by default and filters by industry via registry", async () => {
    const result = await check({ text: "このサプリで花粉症が治る" });
    expect(result.violations.some((v) => v.ruleId === "JP-YAKKI-001")).toBe(true);

    const registry = createRuleRegistry([]);
    registry.register({ ...keywordRule, industryFilter: ["finance"] });
    const finance = await check({ text: "絶対儲かる", industry: "finance", registry });
    expect(finance.violations).toHaveLength(1);
    const medical = await check({ text: "絶対儲かる", industry: "medical", registry });
    expect(medical.violations).toHaveLength(0);
  });

  it("survives a failing store (persistence is best-effort)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await check({
      text: "絶対儲かる",
      rules: [keywordRule],
      store: { saveCheck: vi.fn().mockRejectedValue(new Error("db down")) },
    });
    expect(result.riskScore).toBe(40);
    expect(result.checkId).toBeNull();
    consoleErrorSpy.mockRestore();
  });
});
