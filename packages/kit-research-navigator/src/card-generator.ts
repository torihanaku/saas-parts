/**
 * Use Case Card 生成。
 * - generateManualCard: 手動入力 → LLM で UseCaseCard JSON を生成 (検証 + 1 リトライ)
 * - buildStackAdvisorCard: Stack Advisor の推薦 → カード (LLM 不要の決定的組み立て)
 *
 * 出典: 実運用SaaS server/lib/navigator/card-generator.ts,
 *       server/routes/navigator/cards.ts (buildStackAdvisorCard)
 */
import type { LlmClient } from "./ports";
import type { UseCaseCard } from "./types";
import { UseCaseCardSchema } from "./schemas";

const SYSTEM_PROMPT = `
あなたはn8n風のUse Case Cardを生成します。
入力: source(manual) + ユーザーのプロジェクト記述
出力: UseCaseCard スキーマ準拠のJSON
原則:
- integration.bridgeType は最も現実的なものを選ぶ(推測禁止、不明なら 'manual')
- output.draftText は100〜400字、日本語でユーザートーン模倣
- meta.rationale は「なぜこのカードが今、このユーザーに必要か」を3文以内
- meta.generatedBy は 'llm' にする
- meta.sourceVersion は 'v1' にする
- output.kind は 'issue' | 'social_post' | 'internal_note' | 'architecture_change' | 'experiment_spec' のいずれか
`;

export interface GenerateCardOptions {
  model?: string;
  maxTokens?: number;
  now?: () => Date;
  onWarn?: (message: string, error?: unknown) => void;
}

export async function generateManualCard(
  rawInput: string,
  projectContext: string,
  llm: LlmClient,
  options: GenerateCardOptions = {},
): Promise<UseCaseCard | null> {
  const userPrompt = `
以下の手動入力とプロジェクト文脈からUse Case CardのJSONを生成してください。

【手動入力】
${rawInput}

【プロジェクト文脈】
${projectContext || "なし"}
`;

  try {
    const result = await llm.generateJson<UseCaseCard>({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: options.maxTokens ?? 2000,
      model: options.model,
    });

    const parsed = UseCaseCardSchema.safeParse(result);
    if (parsed.success) return parsed.data;

    options.onWarn?.(
      `card-generator: validation failed: ${parsed.error.message}`,
    );

    // スキーマ違反時はエラー内容を添えて 1 回だけリトライ
    const retryResult = await llm.generateJson<UseCaseCard>({
      system: SYSTEM_PROMPT,
      user: `${userPrompt}\n\n前の出力はエラーでした: ${parsed.error.message}\n正しいスキーマに従ってください。`,
      maxTokens: options.maxTokens ?? 2000,
      model: options.model,
    });
    const retryParsed = UseCaseCardSchema.safeParse(retryResult);
    return retryParsed.success ? retryParsed.data : null;
  } catch (error) {
    options.onWarn?.("card-generator: generation failed", error);
    return null;
  }
}

export interface StackAdvisorCardInput {
  triggerStackId: string;
  title: string;
  summary: string;
  hypothesis?: string;
  assumption?: string;
  testPlan?: string;
  invalidationCriteria?: string;
}

/** Stack Advisor 推薦からカードデータを決定的に組み立てる (LLM 不要)。 */
export function buildStackAdvisorCard(
  input: StackAdvisorCardInput,
  now: () => Date = () => new Date(),
): UseCaseCard {
  const draftParts = [
    input.hypothesis ? `Hypothesis: ${input.hypothesis}` : null,
    input.assumption ? `Assumption: ${input.assumption}` : null,
    input.testPlan ? `Test plan: ${input.testPlan}` : null,
    input.invalidationCriteria
      ? `Invalidation: ${input.invalidationCriteria}`
      : null,
  ].filter((p): p is string => p !== null);

  return {
    source: {
      kind: "stack_advice",
      title: input.title,
      summary: input.summary,
      capturedAt: now().toISOString(),
    },
    tool: {
      kind: "stack",
      name: input.title,
    },
    integration: {
      bridgeType: "manual",
      notes: `Generated from Stack Advisor recommendation ${input.triggerStackId}.`,
    },
    output: {
      kind: "experiment_spec",
      draftText: draftParts.length > 0 ? draftParts.join("\n") : input.summary,
    },
    meta: {
      importanceScore: 0.7,
      rationale: input.summary,
      generatedBy: "hybrid",
      sourceVersion: "v1",
    },
  };
}
