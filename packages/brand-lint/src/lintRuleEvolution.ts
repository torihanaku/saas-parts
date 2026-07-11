import type { GenerateJson } from "./types.js";
import type { BrandLintStore, DnaSnapshotRow, RuleProposalInsert } from "./stores.js";
import { HARD_CUTOFF_DAYS, selectRelevantSamples } from "./hardNegativeDecay.js";

export interface RuleEvolutionDeps {
  store: BrandLintStore;
  /**
   * ルール提案生成用の LLM。原実装の `generateJson(prompt, system, maxTokens)` を
   * 汎用 {@link GenerateJson} 契約に合わせ (system, user, fallback, opts) で呼ぶ。
   */
  generateJson: GenerateJson;
}

interface ProposedRule {
  proposed_rule_key?: string;
  description_ja?: string;
  pattern?: string;
  pattern_type?: RuleProposalInsert["pattern_type"];
  severity?: RuleProposalInsert["severity"];
}

const RULE_EVOLUTION_SYSTEM =
  "You are a brand compliance expert. Output only valid JSON.";

/**
 * 却下事例からのルール自動進化。
 *
 * 全テナントについて、減衰ウィンドウ内（HARD_CUTOFF_DAYS）の rejected hard negative を集め、
 * 減衰重みで上位 50 件に絞ってから LLM にパターンを抽出させ、ルール提案（pending）を挿入する。
 * 5 年前など古すぎる NG は自動的に除外され、新しいルール生成を駆動しない。
 */
export async function runRuleEvolution(
  deps: RuleEvolutionDeps,
): Promise<{ proposals: number }> {
  let totalProposals = 0;

  const tenantIds = await deps.store.listTenantIds();

  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - HARD_CUTOFF_DAYS);
  const sinceIso = sinceDate.toISOString();

  for (const tenantId of tenantIds) {
    const rawSnapshots = await deps.store.listRejectedSnapshots(tenantId, sinceIso);
    if (rawSnapshots.length === 0) continue;

    // 減衰を適用: しきい値未満を除外 + 重み上位 50 件に制限。
    const snapshots = selectRelevantSamples(rawSnapshots as DnaSnapshotRow[], { topK: 50 });
    if (snapshots.length === 0) continue;

    const userPrompt = `Analyze these rejected submissions and propose 1 to 3 compliance rules to prevent similar rejections in the future.
Rejections:
${snapshots.map((s) => `- Reason: ${s.rejection_reason}\n  Text: ${s.content_text}`).join("\n\n")}

Output JSON format:
{
  "rules": [
    {
      "proposed_rule_key": "snake_case_key",
      "description_ja": "日本語の説明",
      "pattern": "keyword1, keyword2 OR regex OR prompt instructions",
      "pattern_type": "keyword" | "regex" | "llm_prompt",
      "severity": "error" | "warning" | "info"
    }
  ]
}`;

    try {
      const response = await deps.generateJson<{ rules?: ProposedRule[] }>(
        RULE_EVOLUTION_SYSTEM,
        userPrompt,
        { rules: [] },
        { maxTokens: 1000 },
      );
      const rules = response?.rules || [];

      for (const rule of rules) {
        const { proposed_rule_key, description_ja, pattern, pattern_type, severity } = rule;
        if (!proposed_rule_key || !description_ja || !pattern || !pattern_type || !severity) {
          continue;
        }

        try {
          await deps.store.insertRuleProposal({
            tenant_id: tenantId,
            proposed_rule_key,
            description_ja,
            pattern,
            pattern_type,
            severity,
            status: "pending",
            evidence_snapshot_ids: snapshots.map((s) => s.id),
          });
          totalProposals++;
        } catch (insertError) {
          console.error("Failed to insert rule proposal", insertError);
        }
      }
    } catch (e) {
      console.error(`Rule evolution failed for tenant ${tenantId}`, e);
    }
  }

  return { proposals: totalProposals };
}
