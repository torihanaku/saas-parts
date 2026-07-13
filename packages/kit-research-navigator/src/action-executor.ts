/**
 * カードのアクション実行ヘルパー。
 * - SNS 投稿ドラフト生成 (LLM 注入)
 * - issue 起票は IssueProvider 経由 (card-service.executeCardAction 参照)
 *
 * 出典: 実運用SaaS server/lib/navigator/action-executor.ts
 * (executeGithubIssue は IssueProvider.createIssue に一般化)
 */
import type { LlmClient } from "./ports";

const SOCIAL_SYSTEM_PROMPT = `
あなたはSNS投稿のドラフト生成AIです。
与えられた下書きと理由を元に、SNSに適したカジュアルなトーンの投稿文（140文字程度）を1つ生成してください。
返信は投稿文のみとしてください。
`;

export async function generateSocialDraft(
  llm: LlmClient,
  draftText: string,
  rationale: string,
  options: { maxTokens?: number; onWarn?: (m: string, e?: unknown) => void } = {},
): Promise<string | null> {
  const userPrompt = `
【下書き】
${draftText}

【背景理由】
${rationale}
`;

  try {
    const text = await llm.generateText({
      system: SOCIAL_SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: options.maxTokens ?? 300,
    });
    return text.trim() || null;
  } catch (error) {
    options.onWarn?.("action-executor: social draft generation failed", error);
    return null;
  }
}
