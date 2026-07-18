import type { ComponentType } from "react";
// 高度チャート
import { WaterfallChart } from "../charts/WaterfallChart";
import { GaugeChart } from "../charts/GaugeChart";
import { FunnelChart } from "../charts/FunnelChart";
import { BulletChart } from "../charts/BulletChart";
import { HistogramChart } from "../charts/HistogramChart";
import { HeatmapChart } from "../charts/HeatmapChart";
import { BoxplotChart } from "../charts/BoxplotChart";
import { TreemapChart } from "../charts/TreemapChart";
import { CandlestickChart } from "../charts/CandlestickChart";
import { SankeyChart } from "../charts/SankeyChart";
import { PivotTable } from "../charts/PivotTable";
import { GeoChart } from "../charts/GeoChart";
import { BubbleMapChart } from "../charts/BubbleMapChart";
// 基本チャート
import { BarChart } from "../charts/BarChart";
import { LineChart } from "../charts/LineChart";
import { AreaChart } from "../charts/AreaChart";
import { PieChart } from "../charts/PieChart";
import { ComboChart } from "../charts/ComboChart";
import { ScatterChart } from "../charts/ScatterChart";
import { BubbleChart } from "../charts/BubbleChart";
import { TableChart } from "../charts/TableChart";
import { ScoreCard } from "../charts/ScoreCard";
import { TimelineChart } from "../charts/TimelineChart";
import { WordCloudChart } from "../charts/WordCloudChart";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyChart = ComponentType<any>;

/**
 * ウィジェット type 文字列 → チャートコンポーネントの対応表。
 * dataProvider が返す props をそのまま spread して描画する。
 */
export const WIDGET_REGISTRY: Record<string, AnyChart> = {
  // 基本
  bar: BarChart,
  line: LineChart,
  area: AreaChart,
  pie: PieChart,
  combo: ComboChart,
  scatter: ScatterChart,
  bubble: BubbleChart,
  table: TableChart,
  scorecard: ScoreCard,
  timeline: TimelineChart,
  wordcloud: WordCloudChart,
  // 高度
  waterfall: WaterfallChart,
  gauge: GaugeChart,
  funnel: FunnelChart,
  bullet: BulletChart,
  histogram: HistogramChart,
  heatmap: HeatmapChart,
  boxplot: BoxplotChart,
  treemap: TreemapChart,
  candlestick: CandlestickChart,
  sankey: SankeyChart,
  pivot: PivotTable,
  geo: GeoChart,
  "bubble-map": BubbleMapChart,
};

export type WidgetType = keyof typeof WIDGET_REGISTRY;
