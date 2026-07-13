/**
 * JP law rule library — barrel export + static rule application.
 *
 * Ported from 実運用SaaS `server/lib/compliance/rules/index.ts`
 * (Issue #934: 50+ rule seed for 薬機法 / 景表法 / 特商法).
 *
 * Total: 50 rules
 *   - YAKKIHOU_RULES   : 20 (薬機法)
 *   - KEIHYOUHOU_RULES : 20 (景表法)
 *   - TOKUSHOUHOU_RULES: 10 (特商法)
 *
 * The rules are pure data. The regexes / wordlists ARE the value of this
 * package — keep them verbatim when updating, and extend via
 * `createRuleRegistry` rather than editing in place.
 */
import type { ComplianceViolation, Industry, JpLawRule } from "../types";
import { YAKKIHOU_RULES } from "./yakkihou";
import { KEIHYOUHOU_RULES } from "./keihyouhou";
import { TOKUSHOUHOU_RULES } from "./tokushouhou";

export { YAKKIHOU_RULES, KEIHYOUHOU_RULES, TOKUSHOUHOU_RULES };

export const ALL_JP_LAW_RULES: JpLawRule[] = [
  ...YAKKIHOU_RULES,
  ...KEIHYOUHOU_RULES,
  ...TOKUSHOUHOU_RULES,
];

export const JP_LAW_RULE_COUNT = ALL_JP_LAW_RULES.length;

/**
 * Apply the static JP-law rule library against an arbitrary text.
 * Returns the same `ComplianceViolation` shape used by the checker so
 * callers can mix static and custom rules interchangeably.
 *
 * NOTE: only `regex` and `keyword` patternType are evaluated here.
 * `llm_prompt` rules require an LLM callback and are handled by the
 * checker's LLM path.
 */
export function applyStaticJpLawRules(
  text: string,
  rules: JpLawRule[] = ALL_JP_LAW_RULES,
): ComplianceViolation[] {
  const violations: ComplianceViolation[] = [];

  for (const rule of rules) {
    if (rule.patternType === "regex") {
      try {
        const regex = new RegExp(rule.pattern, "gi");
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          violations.push({
            ruleId: rule.id,
            severity: rule.severity,
            matchedText: match[0],
            span: [match.index, match.index + match[0].length],
            suggestion: rule.suggestedAlternative ?? null,
          });
          // Prevent infinite loop for zero-width matches.
          if (match.index === regex.lastIndex) regex.lastIndex++;
        }
      } catch (e) {
        console.warn(`[jp-law-rules] invalid regex for rule ${rule.id}:`, e);
      }
    } else if (rule.patternType === "keyword") {
      let keywords: string[];
      try {
        const parsed: unknown = JSON.parse(rule.pattern);
        if (!Array.isArray(parsed)) continue;
        keywords = parsed.filter((k): k is string => typeof k === "string");
      } catch {
        continue;
      }
      for (const kw of keywords) {
        if (kw.length === 0) continue;
        let idx = text.indexOf(kw);
        while (idx !== -1) {
          violations.push({
            ruleId: rule.id,
            severity: rule.severity,
            matchedText: kw,
            span: [idx, idx + kw.length],
            suggestion: rule.suggestedAlternative ?? null,
          });
          idx = text.indexOf(kw, idx + kw.length);
        }
      }
    }
    // llm_prompt rules are intentionally skipped — handled elsewhere.
  }

  return violations;
}

// ── extensible rule registry ─────────────────────────────────────────────────

export interface RuleRegistry {
  /** Register an additional rule. Throws on duplicate id. */
  register(rule: JpLawRule): void;
  /** Register several rules at once. */
  registerAll(rules: JpLawRule[]): void;
  /** Rules applicable to an industry (empty industryFilter = all industries). */
  getRules(industry?: Industry): JpLawRule[];
  /** All registered rules (copy). */
  all(): JpLawRule[];
}

/**
 * Extensible registry seeded with the bundled 50-rule JP-law library by
 * default. Add your own brand / industry rules on top:
 *
 * ```ts
 * const registry = createRuleRegistry();
 * registry.register({ id: "MY-001", lawCode: "keihyo", ruleKey: "brand_ban", ... });
 * ```
 */
export function createRuleRegistry(initial: JpLawRule[] = ALL_JP_LAW_RULES): RuleRegistry {
  const rules: JpLawRule[] = [...initial];
  const ids = new Set(rules.map((r) => r.id));
  return {
    register(rule: JpLawRule): void {
      if (ids.has(rule.id)) throw new Error(`duplicate rule id: ${rule.id}`);
      ids.add(rule.id);
      rules.push(rule);
    },
    registerAll(extra: JpLawRule[]): void {
      for (const r of extra) this.register(r);
    },
    getRules(industry?: Industry): JpLawRule[] {
      if (!industry) return [...rules];
      return rules.filter(
        (r) =>
          !r.industryFilter ||
          r.industryFilter.length === 0 ||
          r.industryFilter.includes(industry),
      );
    },
    all(): JpLawRule[] {
      return [...rules];
    },
  };
}
