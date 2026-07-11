/**
 * Budget optimization, cost forecasting, and executive report generation
 * (ported from dev-dashboard-v2 server/lib/budget-optimizer.ts).
 *
 * The original targeted GCP billing data. The logic is domain-agnostic enough
 * to reuse for any cost stream. All LLM calls are injected via `LlmClient`; the
 * external `timeseries-analysis` package dependency is replaced by an inlined
 * AR(1) least-squares so the package stays self-contained.
 */

import type { LlmClient } from "./llm";

export interface OptimizationRecommendation {
  title: string;
  impact_estimate: string;
  priority: "high" | "medium" | "low";
  description: string;
  action_steps: string[];
}

export interface OptimizationResult {
  recommendations: OptimizationRecommendation[];
  total_potential_savings: string;
}

export interface ForecastResult {
  forecast: { date: string; cost: number; lower: number; upper: number }[];
  trend: "increasing" | "decreasing" | "stable";
  monthEndEstimate: number;
  narrative: string;
}

const OPTIMIZATION_SYSTEM = `あなたはコスト最適化の専門家です。提供されたコストデータを分析し、具体的な最適化提案を日本語で生成してください。

回答はJSON形式のみ:
{
  "recommendations": [
    {
      "title": "提案のタイトル",
      "impact_estimate": "月額 ¥X,XXX の削減見込み",
      "priority": "high" | "medium" | "low",
      "description": "具体的な説明",
      "action_steps": ["手順1", "手順2", "手順3"]
    }
  ],
  "total_potential_savings": "月額 ¥XX,XXX の削減見込み"
}`;

const OPTIMIZATION_FALLBACK: OptimizationResult = {
  recommendations: [],
  total_potential_savings: "",
};

/**
 * Generate cost optimization recommendations from cost data via the LLM.
 */
export async function generateOptimization(
  llm: LlmClient,
  costData: unknown,
  analyticsContext?: string,
): Promise<OptimizationResult> {
  const promptParts: string[] = [`## コストデータ\n${JSON.stringify(costData, null, 2)}`];
  if (analyticsContext) {
    promptParts.push(`## プロジェクトコンテキスト\n${analyticsContext}`);
  }
  return llm.generateJson<OptimizationResult>(
    OPTIMIZATION_SYSTEM,
    promptParts.join("\n\n"),
    OPTIMIZATION_FALLBACK,
    { maxTokens: 3000 },
  );
}

const FORECAST_FALLBACK: ForecastResult = {
  forecast: [],
  trend: "stable",
  monthEndEstimate: 0,
  narrative: "予測を生成できませんでした。",
};

/**
 * Least-squares AR(1) coefficient for a differenced series: fits x[t] = a·x[t-1].
 */
function ar1Coefficient(values: number[]): number {
  let num = 0;
  let den = 0;
  for (let i = 1; i < values.length; i++) {
    num += values[i - 1]! * values[i]!;
    den += values[i - 1]! * values[i - 1]!;
  }
  return den === 0 ? 0 : num / den;
}

function stdev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * 30-day cost forecast from historical daily costs, using an ARIMA(1,1,1)-style
 * approximation (differencing + AR(1)) with a random-walk-scaled 95% CI. The
 * narrative summary is produced by the injected LLM.
 */
export async function generateForecast(
  llm: LlmClient,
  historicalCosts: { date: string; cost: number }[],
): Promise<ForecastResult> {
  if (!historicalCosts || historicalCosts.length < 7) {
    return { ...FORECAST_FALLBACK, narrative: "データ不足です（最低7日間のデータが必要です）。" };
  }

  try {
    const originalLastValue = historicalCosts[historicalCosts.length - 1]!.cost;
    const diffValues: number[] = [];
    for (let i = 1; i < historicalCosts.length; i++) {
      diffValues.push(historicalCosts[i]!.cost - historicalCosts[i - 1]!.cost);
    }

    const coeff = ar1Coefficient(diffValues);
    const std = stdev(diffValues);

    const forecast: ForecastResult["forecast"] = [];
    const lastDate = new Date(historicalCosts[historicalCosts.length - 1]!.date);
    let currentLastValue = originalLastValue;
    let currentLastDiff = diffValues[diffValues.length - 1]!;

    for (let i = 1; i <= 30; i++) {
      const nextDate = new Date(lastDate);
      nextDate.setDate(lastDate.getDate() + i);

      const nextDiff = coeff * currentLastDiff;
      const predictedCost = Math.max(0, currentLastValue + nextDiff);
      const margin = 2 * std * Math.sqrt(i);

      forecast.push({
        date: nextDate.toISOString().slice(0, 10),
        cost: Math.round(predictedCost * 100) / 100,
        lower: Math.max(0, Math.round((predictedCost - margin) * 100) / 100),
        upper: Math.round((predictedCost + margin) * 100) / 100,
      });

      currentLastValue = predictedCost;
      currentLastDiff = nextDiff;
    }

    const startVal = originalLastValue;
    const endVal = forecast[forecast.length - 1]!.cost;
    const change = startVal === 0 ? 0 : (endVal - startVal) / startVal;

    let trend: ForecastResult["trend"] = "stable";
    if (change > 0.05) trend = "increasing";
    else if (change < -0.05) trend = "decreasing";

    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const remainingDays = endOfMonth - now.getDate();

    const actualSoFar = historicalCosts
      .filter((c) => new Date(c.date).getMonth() === now.getMonth())
      .reduce((sum, c) => sum + c.cost, 0);
    const forecastForMonth = forecast.slice(0, remainingDays).reduce((sum, f) => sum + f.cost, 0);
    const monthEndEstimate = Math.round((actualSoFar + forecastForMonth) * 100) / 100;

    const summaryPrompt = `
以下はコストの30日間の予測データ（統計モデルによる算出）です。
このデータを分析し、エグゼクティブ向けに100文字程度で要約・助言を日本語で生成してください。

## トレンド: ${trend}
## 予測値（一部抜粋）:
${JSON.stringify(forecast.slice(0, 5), null, 2)}
...
${JSON.stringify(forecast.slice(-5), null, 2)}

## 月末の着地見込み: ¥${monthEndEstimate.toLocaleString()}
`;

    const narrative = await llm.generateText(
      "あなたはコスト分析の専門家です。統計予測の結果を受けて、簡潔なサマリと推奨事項を日本語で提示してください。",
      summaryPrompt,
      { maxTokens: 500 },
    );

    return { forecast, trend, monthEndEstimate, narrative };
  } catch {
    return FORECAST_FALLBACK;
  }
}

const EXECUTIVE_REPORT_SYSTEM = `あなたはCMO向けの月次レポートを作成するエグゼクティブアシスタントです。
提供された各種データを分析し、以下の構成で日本語のMarkdownレポートを生成してください。

## レポート構成
1. **エグゼクティブサマリー** — 3行以内で全体状況を要約
2. **KPIサマリー** — 主要指標を表形式で
3. **主要成果** — 今月のハイライト（箇条書き）
4. **課題・リスク** — 対応が必要な事項（優先度付き）
5. **コスト分析** — 前月比・トレンド
6. **翌月計画** — 推奨アクション（具体的に）`;

/**
 * Generate an executive-level monthly Markdown report from cost + context data.
 */
export async function generateExecutiveReport(
  llm: LlmClient,
  contexts: {
    costData?: unknown;
    analyticsContext?: string;
    seoContext?: string;
    competitiveContext?: string;
  },
): Promise<string> {
  const promptParts: string[] = [];
  if (contexts.costData) {
    promptParts.push(`## コストデータ\n${JSON.stringify(contexts.costData, null, 2)}`);
  }
  if (contexts.analyticsContext) promptParts.push(`## アナリティクス\n${contexts.analyticsContext}`);
  if (contexts.seoContext) promptParts.push(`## SEO\n${contexts.seoContext}`);
  if (contexts.competitiveContext) promptParts.push(`## 競合情報\n${contexts.competitiveContext}`);

  const userPrompt =
    promptParts.length > 0
      ? `以下のデータを基に月次エグゼクティブレポートを作成してください。\n\n${promptParts.join("\n\n")}`
      : "利用可能なデータがありません。一般的な月次レポートテンプレートを生成してください。";

  return llm.generateText(EXECUTIVE_REPORT_SYSTEM, userPrompt, { maxTokens: 4000 });
}
