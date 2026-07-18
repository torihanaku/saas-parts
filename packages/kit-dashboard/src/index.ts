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

// --- Charts (Phase 1+) ---
export {
  WaterfallChart,
  type WaterfallChartProps,
  type WaterfallItem,
  type WaterfallItemType,
} from "./charts/WaterfallChart";
