// @torihanaku/kit-dashboard — public API
//
// テーマ非依存のダッシュボード/チャートUIキット。色は shadcn の CSS 変数
// (--chart-1..8, --foreground, --border, --card, --muted-foreground, --popover)
// を参照し、取り込み先のテーマ／ダークモードに自動追従する。
// スタイル前提: `import "@torihanaku/kit-dashboard/theme.css"` で変数の既定値を供給。

// --- Types ---
export type * from "./lib/types";

// --- Theme / color resolution ---
export {
  token,
  chartColorVar,
  resolveVar,
  resolveChartColor,
  FALLBACK_PALETTE,
  PALETTE_SIZE,
} from "./lib/theme";
export {
  getChartColor,
  getTrendColor,
  getColorScheme,
  setGlobalChartColors,
  getGlobalChartColors,
  COLOR_SCHEMES,
} from "./lib/colorUtils";

// --- Shared runtime (hooks / helpers) ---
export { useD3 } from "./lib/useD3";
export { useResizeObserver, type Dimensions } from "./lib/useResizeObserver";
export { useTooltip, type TooltipState } from "./lib/useTooltip";
export { useSort, type SortDir } from "./lib/useSort";
export { DEFAULT_MARGIN, getInnerDimensions, type ChartMargin } from "./lib/d3Helpers";
export {
  formatCompact,
  formatNumber,
  formatPercent,
  formatDate,
  formatDateShort,
  applyNumberFormat,
} from "./lib/formatters";
export { cn } from "./lib/cn";

// --- Primitives ---
export { ChartTooltip, type ChartTooltipProps } from "./primitives/ChartTooltip";

// --- Charts (Phase 1: recharts で描けない高度チャート) ---
export {
  WaterfallChart,
  type WaterfallChartProps,
  type WaterfallItem,
  type WaterfallItemType,
} from "./charts/WaterfallChart";
export { GaugeChart, type GaugeChartProps, type GaugeRange } from "./charts/GaugeChart";
export { FunnelChart, type FunnelChartProps, type FunnelStep } from "./charts/FunnelChart";
export {
  BulletChart,
  type BulletChartProps,
  type BulletItem,
  type BulletRange,
} from "./charts/BulletChart";
export { HistogramChart, type HistogramChartProps } from "./charts/HistogramChart";
export {
  HeatmapChart,
  type HeatmapChartProps,
  type HeatmapCell,
  type CalendarCell,
  type HeatmapMode,
} from "./charts/HeatmapChart";
export {
  BoxplotChart,
  type BoxplotChartProps,
  type BoxplotSeries,
  type BoxplotColorScheme,
} from "./charts/BoxplotChart";
export { TreemapChart, type TreemapChartProps, type TreemapNode } from "./charts/TreemapChart";
export {
  CandlestickChart,
  type CandlestickChartProps,
  type CandlestickData,
} from "./charts/CandlestickChart";
export {
  SankeyChart,
  type SankeyChartProps,
  type SankeyNode,
  type SankeyLink,
  type SankeyLinkColorMode,
  SANKEY_DEFAULT_NODES,
  SANKEY_DEFAULT_LINKS,
  SANKEY_SAAS_NODES,
  SANKEY_SAAS_LINKS,
} from "./charts/SankeyChart";
export {
  PivotTable,
  type PivotTableProps,
  type PivotCellMode,
  PIVOT_DEFAULT_ROWS,
  PIVOT_DEFAULT_COLS,
  PIVOT_DEFAULT_DATA,
} from "./charts/PivotTable";
export { GeoChart, type GeoChartProps, type GeoDataPoint } from "./charts/GeoChart";
export {
  BubbleMapChart,
  type BubbleMapChartProps,
  type BubbleMapPoint,
} from "./charts/BubbleMapChart";
