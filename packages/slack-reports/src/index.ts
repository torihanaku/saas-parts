/**
 * @torihanaku/slack-reports — 定期レポートの Slack Block Kit ビルダー集
 *
 * 実運用SaaS の 4 種の定期 Slack レポート
 * (週次レポート / 経営ステータス / シナリオ予測サマリー / Firewall 週次精度)
 * から「Block Kit を組み立てる型」だけを抽出したもの。
 *
 * 設計:
 * - データ取得は provider (`ReportDefinition.provider`) に注入。
 * - 送信は sender (`SlackReportSender`) に注入。
 *   `@torihanaku/slack-harness` の `postSlackDm` 等がシグネチャを充足するが import はしない。
 * - 文言・書式はビルダーごとの `*Copy` config に集約 (原文をデフォルト値で保持)。
 * - 複数レポートを名前で束ねる `ReportRegistry` を同梱。
 *
 * 出典:
 * - server/services/weeklyReportSlack.ts (#1024)
 * - server/services/executiveStatusSlack.ts (#1034)
 * - server/services/slackScenarioSummary.ts
 * - server/services/firewallEvalWeeklySlack.ts (#1040)
 */

export type {
  BlockKitPayload,
  SlackReportSender,
  ReportTenant,
  IsoWeekFn,
} from "./types";

export { isoWeek } from "./iso-week";

export {
  type WeeklyReportCopy,
  DEFAULT_WEEKLY_REPORT_COPY,
  buildWeeklyReportPayload,
} from "./builders/weekly-report";

export {
  type ExecutiveStatusCopy,
  DEFAULT_EXECUTIVE_STATUS_COPY,
  buildExecutiveStatusPayload,
} from "./builders/executive-status";

export {
  type ScenarioPrediction,
  type ScenarioSummaryInput,
  type ScenarioSummaryCopy,
  DEFAULT_SCENARIO_SUMMARY_COPY,
  buildScenarioSummaryPayload,
} from "./builders/scenario-summary";

export {
  type EvalRun,
  type FirewallEvalCopy,
  DEFAULT_FIREWALL_EVAL_COPY,
  pct,
  buildFirewallEvalPayload,
} from "./builders/firewall-eval";

export {
  type ReportDefinition,
  type RunReportResult,
  type RunReportOptions,
  runReport,
  ReportRegistry,
} from "./registry";
