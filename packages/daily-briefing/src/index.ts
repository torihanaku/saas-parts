/**
 * @torihanaku/daily-briefing — 毎朝の AI ブリーフィング編成
 *
 * dev-dashboard-v2 の AI Daily Dashboard (#721) と Briefings ルートから
 * 「ウィジェットデータ収集 → LLM 要約 → パーソナライズ構成」の編成ロジックを抽出。
 *
 * 3 レイヤー:
 * 1. データソース registry (sources.ts / registry.ts) — dataSource 名で実データ取得。
 *    DB アクセスは `TableQuery` 注入。
 * 2. ブリーフィング本文生成 (briefing.ts) — 活動メトリクス collector → LLM 要約。
 * 3. パーソナライズ構成 (compose.ts) — 文脈/シグナル/お気に入り → LLM 構成 → DashboardSpec。
 *    キャッシュ・永続化・レイアウトは @torihanaku/widget-store 側 (README 参照、import なし)。
 *
 * 出典:
 * - server/lib/widget-data/sources.ts
 * - server/routes/briefings.ts
 * - server/routes/daily-dashboard.ts
 */

export type {
  DateRange,
  SourceParams,
  ChartSpec,
  WidgetDataResponse,
  TableQuery,
  WidgetDataFetcher,
  GenerateText,
} from "./types";

export {
  type SourceTableConfig,
  DEFAULT_SOURCE_TABLES,
  makeFetchGa4,
  makeFetchCosts,
  makeFetchCampaigns,
  makeFetchSns,
} from "./sources";

export {
  WidgetDataRegistry,
  createDefaultWidgetDataRegistry,
} from "./registry";

export {
  type ActivityMetric,
  type ActivityCollector,
  type BriefingCopy,
  type GenerateBriefingOptions,
  DEFAULT_BRIEFING_COPY,
  formatActivityMetrics,
  generateBriefingContent,
  getYesterdayDate,
} from "./briefing";

export {
  type WidgetSpec,
  type DashboardSpec,
  type ComposeInput,
  type ComposeOutput,
  type ComposeFn,
  type BriefingComposeDeps,
  ComposeError,
  composeDailyBriefing,
  composeShot,
} from "./compose";
