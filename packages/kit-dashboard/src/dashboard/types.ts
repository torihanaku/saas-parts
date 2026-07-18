import type { ReactNode } from "react";

/** グリッド上の配置。x/y は任意、w は列スパン（columns 基準）。 */
export interface WidgetLayout {
  x?: number;
  y?: number;
  /** 列スパン（既定 columns 全体に対する相対幅）。 */
  w?: number;
  h?: number;
}

/** ウィジェット1つの定義。type はチャート種のレジストリキー。 */
export interface DashboardWidget {
  id: string;
  /** レジストリのキー（"line" | "bar" | "pie" | "scorecard" | "table" | "pivot" | ... ）。 */
  type: string;
  title?: string;
  layout?: WidgetLayout;
  /**
   * チャートに常に渡す静的 props。dataProvider が返す props とマージされ、
   * `<Chart {...staticProps} {...fetchedProps} />` の順で適用される（動的が優先）。
   */
  props?: Record<string, unknown>;
}

export type DashboardFilterType =
  | "dropdown"
  | "checkbox"
  | "slider"
  | "date"
  | "input";

/** フィルタバーの1項目。 */
export interface DashboardFilter {
  key: string;
  type: DashboardFilterType;
  label?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: unknown;
}

/** ダッシュボード全体の宣言的定義。 */
export interface DashboardConfig {
  title?: string;
  /** グリッド列数（既定 12）。 */
  columns?: number;
  /** アイテム間余白 px（既定 16）。 */
  gap?: number;
  filters?: DashboardFilter[];
  widgets: DashboardWidget[];
}

/** 現在のフィルタ状態（key → 値）。 */
export type FilterState = Record<string, unknown>;

export interface DataProviderContext {
  widget: DashboardWidget;
  filters: FilterState;
  /** race 検出用。古い結果を捨てるのに使える（内部でも制御している）。 */
  signal?: AbortSignal;
}

/**
 * データ供給の契約：ウィジェットと現在のフィルタを受け取り、
 * **そのチャートに spread する props オブジェクト**を返す（例: `{ data: [...] }`,
 * ScoreCard なら `{ value, previousValue }`, Table なら `{ columns, data }`）。
 * これにより型ごとの分岐なしに全チャートを同じ入口で扱える。
 */
export type DataProvider = (
  ctx: DataProviderContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** 任意の永続化層（@torihanaku/widget-store 互換の最小契約）。 */
export interface DashboardStore {
  load?: () => Promise<DashboardConfig | null> | DashboardConfig | null;
  save?: (config: DashboardConfig) => Promise<void> | void;
}

export interface DashboardProps {
  config: DashboardConfig;
  dataProvider: DataProvider;
  /** 任意: 初期 config を load() で差し替える永続化層。 */
  store?: DashboardStore;
  /** ローディング表示の差し替え。 */
  renderLoading?: (widget: DashboardWidget) => ReactNode;
  /** エラー表示の差し替え。 */
  renderError?: (widget: DashboardWidget, error: Error) => ReactNode;
  className?: string;
}
