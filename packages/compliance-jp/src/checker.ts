/**
 * Compliance checker — regex / keyword / LLM rule evaluation with risk score.
 *
 * Ported from dev-dashboard-v2 `server/lib/compliance/checker-service.ts`.
 * Decoupled:
 *   - tenant industry lookup → caller passes `industry` directly
 *   - DB rule table → rules come from a {@link RuleRegistry} / explicit array
 *   - Claude API call → injected {@link LlmCheckFn} callback
 *   - check-history persistence → optional injected {@link CheckStore}
 *
 * Risk-score weights, summary wording and per-rule error handling are kept
 * verbatim from the source.
 */

import type { ComplianceViolation, Industry, JpLawRule } from "./types";
import { ALL_JP_LAW_RULES, applyStaticJpLawRules, type RuleRegistry } from "./rules/index";

export interface LlmCheckResponse {
  violated: boolean;
  matched_text?: string;
  span?: [number, number];
  reason?: string;
}

/**
 * Injected LLM callback for `llm_prompt` rules. Receives the text and the
 * rule (whose `pattern` is the natural-language rule statement) and returns
 * the verdict. Errors thrown per rule are caught and logged; the check
 * continues with the remaining rules (source behavior).
 */
export type LlmCheckFn = (args: {
  text: string;
  rule: JpLawRule;
}) => Promise<LlmCheckResponse>;

/** Optional history persistence. Return the persisted check id (or null). */
export interface CheckStore {
  saveCheck(record: {
    text: string;
    industry?: Industry;
    contentSourceId?: string | null;
    riskScore: number;
    violations: ComplianceViolation[];
  }): Promise<string | null>;
}

export interface CheckInput {
  text: string;
  industry?: Industry;
  /** Explicit rule set. Takes precedence over `registry`. */
  rules?: JpLawRule[];
  /** Rule registry to draw from (default: bundled 50-rule JP-law library). */
  registry?: RuleRegistry;
  /** LLM callback — without it, `llm_prompt` rules are skipped with a warning. */
  llmCheck?: LlmCheckFn;
  /** Optional history store. */
  store?: CheckStore;
  contentSourceId?: string;
}

export interface CheckOutput {
  /** Persisted check id (null when no store was injected / persist failed). */
  checkId: string | null;
  /** 0-100. */
  riskScore: number;
  violations: ComplianceViolation[];
  /** 日本語サマリ */
  summary: string;
}

/** Severity weights (verbatim from source). */
export const SEVERITY_WEIGHTS: Record<string, number> = {
  error: 40,
  warning: 15,
  info: 5,
};

export async function check(input: CheckInput): Promise<CheckOutput> {
  // 1. Resolve applicable rules.
  const rules =
    input.rules ??
    (input.registry ? input.registry.getRules(input.industry) : ALL_JP_LAW_RULES);

  const violations: ComplianceViolation[] = [];

  // 2. Rule-based check (regex + keyword).
  violations.push(
    ...applyStaticJpLawRules(
      input.text,
      rules.filter((r) => r.patternType === "regex" || r.patternType === "keyword"),
    ),
  );

  // 3. LLM-based check (patternType 'llm_prompt').
  const llmRules = rules.filter((r) => r.patternType === "llm_prompt");
  if (llmRules.length > 0) {
    violations.push(...(await runLlmChecks(input.text, llmRules, input.llmCheck)));
  }

  // 4. Risk score: severity 重み付け (verbatim).
  const rawScore = violations.reduce((s, v) => s + (SEVERITY_WEIGHTS[v.severity] || 0), 0);
  const riskScore = Math.min(100, rawScore);

  // 5. Summary 生成 (日本語, verbatim).
  const summary =
    violations.length === 0
      ? "コンプライアンス上のリスクは検出されませんでした。"
      : `${violations.length} 件のリスクが検出されました（error: ${violations.filter((v) => v.severity === "error").length}, warning: ${violations.filter((v) => v.severity === "warning").length}）。公開前に確認してください。`;

  // 6. Optional history persistence.
  let checkId: string | null = null;
  if (input.store) {
    try {
      checkId = await input.store.saveCheck({
        text: input.text,
        industry: input.industry,
        contentSourceId: input.contentSourceId ?? null,
        riskScore,
        violations,
      });
    } catch (e) {
      console.error("Failed to persist compliance check:", e);
    }
  }

  return { checkId, riskScore, violations, summary };
}

async function runLlmChecks(
  text: string,
  rules: JpLawRule[],
  llmCheck?: LlmCheckFn,
): Promise<ComplianceViolation[]> {
  if (!llmCheck) {
    console.warn(
      JSON.stringify({
        severity: "WARNING",
        message: "llm_check_skipped_no_callback",
        rule_count: rules.length,
      }),
    );
    return [];
  }

  const results: ComplianceViolation[] = [];
  for (const rule of rules) {
    try {
      const parsed = await llmCheck({ text, rule });
      if (parsed.violated) {
        results.push({
          ruleId: rule.id,
          severity: rule.severity,
          matchedText: parsed.matched_text ?? "",
          span: parsed.span ?? [0, 0],
          suggestion: rule.suggestedAlternative ?? null,
        });
      }
    } catch (e: unknown) {
      console.warn(
        JSON.stringify({
          severity: "WARNING",
          message: "llm_check_rule_failed",
          rule_id: rule.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }
  return results;
}

/**
 * Prompt builder matching the source checker's LLM contract. Feed the result
 * to your LLM client inside an injected {@link LlmCheckFn}:
 *
 * ```ts
 * const llmCheck: LlmCheckFn = async ({ text, rule }) => {
 *   const { system, user } = buildLlmCheckPrompt(text, rule);
 *   return await myGenerateJson(system, user); // expects LlmCheckResponse JSON
 * };
 * ```
 */
export function buildLlmCheckPrompt(
  text: string,
  rule: JpLawRule,
): { system: string; user: string } {
  const system =
    "あなたはコンプライアンスチェッカーです。与えられたルールに違反があれば指定された JSON スキーマで、違反がなければ {\"violated\": false} で返してください。JSON 以外のテキストは絶対に含めないでください。";
  const user = `次の文章をルール「${rule.pattern}」でチェックしてください。\n違反があれば JSON で {"violated": true, "matched_text": "...", "span": [start, end], "reason": "..."} を返す。\n違反なしなら {"violated": false}。\n\n文章:\n${text}`;
  return { system, user };
}
