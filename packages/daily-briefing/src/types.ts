/**
 * @torihanaku/daily-briefing — 共有型
 *
 * 「毎朝の AI ブリーフィング」編成に必要な型。
 * DB アクセス・LLM 呼び出し・永続化はすべて注入式。
 */

/** 期間指定。widget データソースの集計ウィンドウに使う。 */
export type DateRange = "1d" | "7d" | "14d" | "30d" | "90d";

/** ウィジェットデータ取得のパラメータ。 */
export interface SourceParams {
  dateRange: DateRange;
  limit: number;
}

/** 中立的なチャート設定 (Tremor / Vega-Lite どちらでも解釈可)。 */
export interface ChartSpec {
  xKey?: string;
  yKey?: string;
  categoryKey?: string;
  valueKey?: string;
  colors?: string[];
}

/** ウィジェットデータソースの応答。空テーブル時は data:[] を返す (placeholder は返さない)。 */
export interface WidgetDataResponse {
  data: Record<string, unknown>[];
  chartSpec: ChartSpec;
  truncated?: boolean;
}

/**
 * テーブルクエリ関数 (注入式)。
 *
 * `table` と PostgREST 互換の `query` 文字列を受け取り、行配列を返す。
 * dev-dashboard-v2 の `supabaseGet(table, query)` がそのままこのシグネチャを充足する。
 */
export type TableQuery = (
  table: string,
  query: string,
) => Promise<Record<string, unknown>[] | null>;

/** ウィジェットデータフェッチャ (registry のエントリ)。 */
export type WidgetDataFetcher = (
  params: SourceParams,
  tenantId: string,
) => Promise<WidgetDataResponse>;

/**
 * テキスト生成 LLM 呼び出し (注入式)。
 * dev-dashboard-v2 の `generateText(apiKey, system, user, options)` を充足する。
 */
export type GenerateText = (
  apiKey: string,
  system: string,
  userPrompt: string,
  options?: { maxTokens?: number },
) => Promise<string | null | undefined>;
