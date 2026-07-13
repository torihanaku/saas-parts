import type { GenerateText } from "./types";

/**
 * 「毎朝の AI ブリーフィング」本文生成。
 * 出典: 実運用SaaS server/routes/briefings.ts の generateBriefingContent。
 *
 * 移植方針:
 * - 個別テーブル集計 (reports/drafts/backlog/deals) は「活動メトリクス収集」を
 *   注入式 collector に一般化。原文の 4 指標を既定 collector として組み立て可能。
 * - LLM 呼び出しは `GenerateText` の注入に置換。
 * - API キー解決 (tenant secret → env) は呼び出し側の責務。
 */

/** ブリーフィングに載せる 1 指標。 */
export interface ActivityMetric {
  /** プロンプトに出す行ラベル (例: "レポート生成")。 */
  label: string;
  /** 主要件数。 */
  count: number;
  /** 補足件数 (例: うち公開済み)。ラベルは detailLabel で指定。 */
  detail?: { label: string; count: number };
}

/** 指定日の活動メトリクスを集める collector (注入式)。 */
export type ActivityCollector = (date: string) => Promise<ActivityMetric>;

export interface BriefingCopy {
  /** システムプロンプト。 */
  system: string;
  /** ユーザープロンプト見出し。`date` を受け取る。 */
  heading: (date: string) => string;
  /** データセクションの締めの指示文。 */
  instruction: string;
  /** LLM が空を返したときのフォールバック本文。 */
  emptyFallback: string;
}

export const DEFAULT_BRIEFING_COPY: BriefingCopy = {
  system:
    "あなたはエグゼクティブアシスタントです。昨日のチームのAI活動を簡潔にまとめたデイリーブリーフィングを日本語で生成してください。箇条書きで読みやすく、重要なアクションアイテムも含めてください。",
  heading: (date) => `昨日（${date}）のAI活動サマリー:`,
  instruction:
    "上記のデータを元に、昨日のAI活動に関するデイリーブリーフィングを生成してください。",
  emptyFallback: "ブリーフィングを生成できませんでした",
};

/** メトリクス配列 → プロンプト用の箇条書き。 */
export function formatActivityMetrics(metrics: ActivityMetric[]): string {
  return metrics
    .map((m) => {
      const base = `- ${m.label}: ${m.count}件`;
      return m.detail ? `${base}（${m.detail.label}: ${m.detail.count}件）` : base;
    })
    .join("\n");
}

export interface GenerateBriefingOptions {
  date: string;
  apiKey: string;
  collectors: ActivityCollector[];
  generateText: GenerateText;
  copy?: BriefingCopy;
  maxTokens?: number;
}

/**
 * 指定日の活動を集め、ブリーフィング本文を生成する。
 *
 * collector は並列実行され、1 つが失敗しても他は反映される (Promise.allSettled)。
 * 失敗した collector は結果から除外される。
 */
export async function generateBriefingContent(
  options: GenerateBriefingOptions,
): Promise<string> {
  const {
    date,
    apiKey,
    collectors,
    generateText,
    copy = DEFAULT_BRIEFING_COPY,
    maxTokens = 1000,
  } = options;

  const settled = await Promise.allSettled(collectors.map((c) => c(date)));
  const metrics: ActivityMetric[] = settled
    .filter((r): r is PromiseFulfilledResult<ActivityMetric> => r.status === "fulfilled")
    .map((r) => r.value);

  const userPrompt = `${copy.heading(date)}

## 活動データ
${formatActivityMetrics(metrics)}

${copy.instruction}`;

  const generated = await generateText(apiKey, copy.system, userPrompt, { maxTokens });
  return generated || copy.emptyFallback;
}

/** 昨日 (UTC) の日付文字列 YYYY-MM-DD。 */
export function getYesterdayDate(now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
