import type { BlockKitPayload } from "../types";

/**
 * シナリオ予測サマリー Block Kit ビルダー。
 * 出典: 実運用SaaS server/services/slackScenarioSummary.ts の buildScenarioBlocks。
 *
 * 元は twin/comparison-service の CompareOutput に依存していたが、
 * 移植にあたり「シナリオ名 + 予測メトリクス (mean)」だけを受け取る汎用形に緩めた。
 */

/** 1 シナリオの予測結果 (最小形)。 */
export interface ScenarioPrediction {
  name: string;
  /** メトリクスキー → 平均値。null/undefined は既定表示 (0) に落ちる。 */
  predictedOutputs: Record<string, { mean?: number | null } | undefined>;
}

export interface ScenarioSummaryInput {
  scenarios: ScenarioPrediction[];
}

export interface ScenarioSummaryCopy {
  fallbackText: (tenantName: string) => string;
  header: (tenantName: string) => string;
  /** 本文リード文 (シナリオ行の前に置かれる)。 */
  lead: string;
  /** context フッター文言。 */
  footer: string;
  /**
   * 表示するメトリクス。`key` は predictedOutputs のキー、`label` は表示名。
   * 既定は PV / CV。
   */
  metrics: Array<{ key: string; label: string }>;
}

export const DEFAULT_SCENARIO_SUMMARY_COPY: ScenarioSummaryCopy = {
  fallbackText: (name) => `【日次】シナリオ予測サマリー: ${name}`,
  header: (name) => `📊 シナリオ予測サマリー (${name})`,
  lead: "現在実行中の施策案に基づいた3つの将来予測シナリオです。",
  footer: "詳細な感度分析はダッシュボードの「シナリオ比較」から確認できます。",
  metrics: [
    { key: "pv", label: "PV" },
    { key: "cv", label: "CV" },
  ],
};

export function buildScenarioSummaryPayload(
  tenantName: string,
  input: ScenarioSummaryInput,
  copy: ScenarioSummaryCopy = DEFAULT_SCENARIO_SUMMARY_COPY,
): BlockKitPayload {
  const scenarioLines = input.scenarios
    .map((s) => {
      const parts = copy.metrics
        .map(({ key, label }) => {
          const value = s.predictedOutputs[key]?.mean?.toLocaleString() || "0";
          return `${label} ${value}`;
        })
        .join(", ");
      return `• *${s.name}*: ${parts}`;
    })
    .join("\n");

  return {
    text: copy.fallbackText(tenantName),
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: copy.header(tenantName) },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `${copy.lead}\n\n${scenarioLines}` },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: copy.footer }],
      },
    ],
  };
}
