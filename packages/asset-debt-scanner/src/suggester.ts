/**
 * 負債修正提案ジェネレータ。
 * 出典: 実運用SaaS server/lib/marketing-debt/suggester.ts (#1297 Debt-3)。
 *
 * 移植方針: LLM 呼び出し (`generateJson`) を注入式に置換。API キー未解決なら FALLBACK を返す。
 */
import type { AssetType } from "./types";

export interface DebtSuggestion {
  title: string;
  description: string;
  estimated_time: string;
  impact: "high" | "medium" | "low";
}

interface SuggestionPayload {
  suggestions: DebtSuggestion[];
}

export const FALLBACK_SUGGESTIONS: DebtSuggestion[] = [
  {
    title: "Review and update the asset",
    description: "Manually review the flagged asset and update or remove it.",
    estimated_time: "1-2 hours",
    impact: "medium",
  },
  {
    title: "Set expiry reminder",
    description: "Add a calendar reminder to revisit this asset in 30 days.",
    estimated_time: "5 minutes",
    impact: "low",
  },
  {
    title: "Archive the asset",
    description: "Move the asset to an archive state to remove it from active rotation.",
    estimated_time: "15 minutes",
    impact: "high",
  },
];

/**
 * JSON 生成 LLM 呼び出し (注入式)。
 * 実運用SaaS の `generateJson(apiKey, system, user, fallback, options)` を充足する。
 */
export type GenerateJson = <T>(
  apiKey: string,
  system: string,
  userPrompt: string,
  fallback: T,
  options?: { maxTokens?: number },
) => Promise<T>;

function buildSystemPrompt(): string {
  return `あなたはマーケティング戦略コンサルタントです。
marketing debt（マーケティング負債）の修正提案を3案、日本語で生成してください。

返却形式 (JSON のみ):
{
  "suggestions": [
    {
      "title": "提案タイトル (20字以内)",
      "description": "具体的な実施内容 (100字以内)",
      "estimated_time": "所要時間 (例: '30分', '2時間', '1日')",
      "impact": "high|medium|low"
    }
  ]
}`;
}

function buildUserPrompt(
  assetType: AssetType,
  assetRef: string,
  severity: string,
  recommendation: string | null,
): string {
  return [
    `負債の種別: ${assetType}`,
    `対象アセット: ${assetRef}`,
    `深刻度: ${severity}`,
    recommendation ? `既存の推奨事項: ${recommendation}` : "",
    "",
    "この負債を解消するために実行できる具体的な修正提案を3案生成してください。",
    "各案は独立して実行可能で、実施しやすい順に並べてください。",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface DebtSuggestionRequest {
  assetType: AssetType;
  assetRef: string;
  severity: string;
  recommendation: string | null;
  /** 解決済み API キー。無ければ FALLBACK を返す。 */
  apiKey?: string;
}

/**
 * 負債 1 件に対して 3 案の修正提案を生成する。
 * apiKey 未指定 or LLM が空を返した場合は FALLBACK_SUGGESTIONS を返す。
 */
export async function generateDebtSuggestions(
  item: DebtSuggestionRequest,
  generateJson: GenerateJson,
): Promise<DebtSuggestion[]> {
  if (!item.apiKey) return FALLBACK_SUGGESTIONS;

  const result = await generateJson<SuggestionPayload>(
    item.apiKey,
    buildSystemPrompt(),
    buildUserPrompt(item.assetType, item.assetRef, item.severity, item.recommendation),
    { suggestions: FALLBACK_SUGGESTIONS },
    { maxTokens: 1200 },
  );

  const suggestions = result.suggestions ?? [];
  return suggestions.length > 0 ? suggestions.slice(0, 3) : FALLBACK_SUGGESTIONS;
}
