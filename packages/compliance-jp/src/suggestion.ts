/**
 * Compliance suggestion service — LLM-backed alternative-copy proposals for
 * a flagged violation.
 *
 * Ported from dev-dashboard-v2 `server/lib/compliance/suggestion-service.ts`.
 * Decoupled: the check/rule DB lookups are gone — the caller passes the
 * content text, the violation and (optionally) the rule metadata directly,
 * and the Claude call became an injected {@link SuggestLlmFn} callback.
 * SYSTEM_PROMPT, the ±100-char context window, and compliance-label
 * validation are kept verbatim.
 */

import type { ComplianceViolation, JpLawRule } from "./types";

export interface SuggestInput {
  /** The full content text the violation was found in. */
  text: string;
  violation: Pick<ComplianceViolation, "matchedText" | "span">;
  /** Rule metadata shown to the LLM (lawCode / ruleKey / descriptionJa). */
  rule?: Pick<JpLawRule, "lawCode" | "ruleKey" | "descriptionJa">;
  maxSuggestions?: number;
}

export interface SuggestOutput {
  suggestions: Array<{
    text: string;
    rationale: string;
    compliance: "fully_compliant" | "conditionally_compliant" | "review_needed";
  }>;
}

export interface RawSuggestion {
  text?: string;
  rationale?: string;
  compliance?: string;
}

/**
 * Injected LLM callback. Receives system prompt + user prompt and returns
 * the parsed JSON array (empty array on failure — do not throw for "no
 * suggestions", mirror the source's generateJson fallback).
 */
export type SuggestLlmFn = (
  system: string,
  userPrompt: string,
  opts: { maxTokens: number },
) => Promise<RawSuggestion[]>;

export const SUGGESTION_SYSTEM_PROMPT = `
あなたは日本の広告法務に精通したコピーライターです。
違反指摘された表現に対し、法的に問題のない代替表現を 3 案提案してください。
各案について、なぜ合法か（rationale）と、適用条件（compliance）を明記してください。
元の意図（販促効果）を可能な限り維持すること。
JSON 配列で返してください: [{"text": "...", "rationale": "...", "compliance": "fully_compliant"|"conditionally_compliant"|"review_needed"}]
`;

export async function suggest(input: SuggestInput, llm: SuggestLlmFn): Promise<SuggestOutput> {
  const { violation } = input;

  const context = input.text.substring(
    Math.max(0, violation.span[0] - 100),
    Math.min(input.text.length, violation.span[1] + 100),
  );

  const userPrompt = `違反ルール: ${input.rule?.lawCode}/${input.rule?.ruleKey}\n違反内容: ${input.rule?.descriptionJa}\n違反箇所: "${violation.matchedText}"\n前後の文脈:\n...${context}...`;

  const suggestions = await llm(SUGGESTION_SYSTEM_PROMPT, userPrompt, { maxTokens: 1200 });

  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    console.warn(
      JSON.stringify({
        severity: "WARNING",
        message: "suggestion_llm_empty_or_failed",
      }),
    );
    return { suggestions: [] };
  }

  const validCompliance = ["fully_compliant", "conditionally_compliant", "review_needed"];

  const result = suggestions.slice(0, input.maxSuggestions ?? 3).map((s: RawSuggestion) => ({
    text: s.text ?? "",
    rationale: s.rationale ?? "",
    compliance: (s.compliance && validCompliance.includes(s.compliance)
      ? s.compliance
      : "review_needed") as SuggestOutput["suggestions"][number]["compliance"],
  }));

  return { suggestions: result };
}
