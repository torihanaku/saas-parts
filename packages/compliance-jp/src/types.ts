/**
 * Core types for JP-law compliance text checking.
 *
 * Ported from 実運用SaaS `src/types/compliance.ts` and
 * `server/lib/compliance/rules/types.ts` (self-contained copy).
 */

export type LawCode =
  | "keihyo"
  | "yakki"
  | "kojinjoho"
  | "tokusho"
  | "chosaku"
  | "industry_finance"
  | "industry_medical"
  | "industry_realestate"
  // Extensible: custom registries may introduce their own law codes.
  | (string & {});

export type Severity = "error" | "warning" | "info";
export type PatternType = "regex" | "keyword" | "llm_prompt";
export type Industry = "finance" | "medical" | "realestate" | "general" | (string & {});

export interface JpLawRule {
  /** Stable rule id used in violation records (e.g. "JP-YAKKI-001"). */
  id: string;
  lawCode: LawCode;
  /** Stable human-readable key (snake_case). Unique per lawCode. */
  ruleKey: string;
  patternType: PatternType;
  /** Regex pattern source string OR JSON-stringified keyword array (OR an LLM prompt for `llm_prompt`). */
  pattern: string;
  severity: Severity;
  descriptionJa: string;
  exampleViolation?: string;
  suggestedAlternative?: string;
  /** Industry filter (empty/undefined = applies to all industries). */
  industryFilter?: string[];
}

export interface ComplianceViolation {
  ruleId: string;
  severity: Severity;
  matchedText: string;
  span: [number, number];
  suggestion: string | null;
}
