/**
 * Ported from dev-dashboard-v2 `tests/compliance-suggestion.test.ts`
 * (LAW-4 Compliance Suggestion). Supabase check/rule lookups replaced by
 * direct inputs; the Claude call is the injected callback.
 */
import { describe, it, expect, vi } from "vitest";

import { suggest, SUGGESTION_SYSTEM_PROMPT, type SuggestLlmFn } from "./suggestion";

const baseInput = {
  text: "Buy now!",
  violation: { matchedText: "Buy", span: [0, 3] as [number, number] },
  rule: { lawCode: "AD", ruleKey: "HARD_SELL", descriptionJa: "強引な勧誘" },
};

describe("LAW-4 Compliance Suggestion", () => {
  it("returns suggestions on success", async () => {
    const llm: SuggestLlmFn = vi
      .fn()
      .mockResolvedValue([
        { text: "Consider now", rationale: "Softer tone", compliance: "fully_compliant" },
      ]);

    const result = await suggest(baseInput, llm);

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.text).toBe("Consider now");
    expect(result.suggestions[0]?.compliance).toBe("fully_compliant");
    expect(llm).toHaveBeenCalledWith(
      SUGGESTION_SYSTEM_PROMPT,
      expect.stringContaining("強引な勧誘"),
      { maxTokens: 1200 },
    );
  });

  it("returns empty list on LLM failure / empty response", async () => {
    const llm: SuggestLlmFn = vi.fn().mockResolvedValue([]);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await suggest(baseInput, llm);
    expect(result.suggestions).toEqual([]);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("suggestion_llm_empty_or_failed"),
    );
    consoleWarnSpy.mockRestore();
  });

  it("normalizes unknown compliance labels to review_needed and caps at maxSuggestions", async () => {
    const llm: SuggestLlmFn = vi.fn().mockResolvedValue([
      { text: "a", rationale: "r1", compliance: "totally_fine" },
      { text: "b", rationale: "r2", compliance: "conditionally_compliant" },
      { text: "c", rationale: "r3" },
      { text: "d", rationale: "r4" },
    ]);
    const result = await suggest({ ...baseInput, maxSuggestions: 3 }, llm);
    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions[0]?.compliance).toBe("review_needed");
    expect(result.suggestions[1]?.compliance).toBe("conditionally_compliant");
    expect(result.suggestions[2]?.compliance).toBe("review_needed");
  });

  it("includes ±100 chars of context around the violation in the prompt", async () => {
    const llm = vi.fn().mockResolvedValue([]);
    const longText = "あ".repeat(300) + "絶対儲かる" + "い".repeat(300);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await suggest(
      {
        text: longText,
        violation: { matchedText: "絶対儲かる", span: [300, 305] },
      },
      llm,
    );
    const userPrompt = llm.mock.calls[0]?.[1] as string;
    expect(userPrompt).toContain("絶対儲かる");
    // context window = 100 before + match + 100 after
    expect(userPrompt).toContain("あ".repeat(100) + "絶対儲かる" + "い".repeat(100));
    expect(userPrompt).not.toContain("あ".repeat(101));
    consoleWarnSpy.mockRestore();
  });
});
