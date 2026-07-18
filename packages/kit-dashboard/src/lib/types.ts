export interface DataPoint {
  label: string
  value: number
  color?: string
}

export interface TimeSeriesPoint {
  date: Date
  value: number
  series?: string
}

export interface BaseChartProps {
  width?: number
  height?: number
  margin?: { top: number; right: number; bottom: number; left: number }
  colors?: readonly string[]
  className?: string
  animated?: boolean
}

// ScoreCard
export type ScoreCardVariant = 'standard' | 'compact' | 'progress-bar' | 'progress-circle' | 'trend-only' | 'comparison'

export interface ScoreCardProps {
  title: string
  value: number | string
  previousValue?: number
  comparisonValue?: string
  changeLabel?: string
  unit?: string
  sparklineData?: number[]
  formatter?: (v: number) => string
  className?: string
  variant?: ScoreCardVariant
  progressMax?: number
  thresholdGood?: number
  thresholdBad?: number
  valueColor?: string
  sparklineUpColor?: string
  sparklineDownColor?: string
}

// BarChart
export type BarOrientation = 'vertical' | 'horizontal'
export interface BarChartProps extends BaseChartProps {
  data: DataPoint[]
  orientation?: BarOrientation
  showLabels?: boolean
  showGrid?: boolean
  onHover?: (d: DataPoint | null) => void
}

// ReferenceLine
export interface ReferenceLine {
  value: number
  label?: string
  color?: string
  style?: 'solid' | 'dashed'
}

// LineChart
export interface LineChartProps extends BaseChartProps {
  data?: TimeSeriesPoint[]
  series?: string[]
  smooth?: boolean
  showDots?: boolean
  showGrid?: boolean
  missingData?: 'zero' | 'break' | 'interpolate'
  seriesCount?: number
  seriesLabels?: string[]
  referenceLines?: ReferenceLine[]
  yAxisMin?: number
  yAxisMax?: number
  thresholdGood?: number
  thresholdBad?: number
  conditionalFormat?: string
}

// AreaChart
export interface AreaChartProps extends LineChartProps {
  stacked?: boolean
  fillOpacity?: number
  variant?: 'standard' | 'stacked' | '100pct'
  smooth?: boolean
}

// PieChart / DonutChart
export type PieLabelMode = 'none' | 'percent' | 'value' | 'label' | 'label+percent' | 'label+value'
export type LegendPosition = 'right' | 'bottom' | 'none'

export interface PieChartProps extends BaseChartProps {
  data?: DataPoint[]
  innerRadius?: number
  showLegend?: boolean
  showLabels?: boolean
  labelMode?: PieLabelMode
  legendPosition?: LegendPosition
}

// TableChart
export interface TableColumn {
  key: string
  label: string
  type: 'string' | 'number' | 'percent' | 'date'
  sortable?: boolean
  width?: number
  align?: 'left' | 'right' | 'center'
}

export interface ConditionalRule {
  column: string
  type: 'color-scale' | 'threshold'
  thresholds?: { value: number; color: string; bgColor: string }[]
}

export interface TableChartProps {
  columns: TableColumn[]
  data: Record<string, string | number>[]
  striped?: boolean
  stickyHeader?: boolean
  defaultSortKey?: string
  defaultSortDir?: 'asc' | 'desc'
  maxRows?: number
  className?: string
  pagination?: number
  searchable?: boolean
  conditionalFormatting?: ConditionalRule[]
  cellVisualization?: Record<string, 'bar'>
  sortOrder?: 'none' | 'asc' | 'desc'
  limitRows?: number
  conditionalFormat?: 'none' | 'row' | 'cell'
  showTotalRow?: boolean
  stickyFirstColumn?: boolean
  cellHeatmap?: string[]
  expandableRows?: boolean
  secondarySortKey?: string
  secondarySortDir?: 'asc' | 'desc'
  columnRules?: Record<string, Array<{ threshold: number; operator: string; color: string }>>
}

// BubbleChart
export interface BubblePoint {
  x: number
  y: number
  size: number
  label: string
  color?: string
}

export interface BubbleChartProps extends BaseChartProps {
  data: BubblePoint[]
  xLabel?: string
  yLabel?: string
  maxBubbleRadius?: number
}

// Multi-series BarChart
export type BarVariant = 'single' | 'grouped' | 'stacked' | 'stacked-100'
export interface BarSeries {
  key: string
  label: string
  color?: string
}
// Extended BarChart props
export interface MultiBarChartProps extends BaseChartProps {
  // For multi-series, use `series` + `seriesData` instead of `data`
  data?: DataPoint[]
  series?: BarSeries[]
  seriesData?: Record<string, Record<string, number>>  // { category: { seriesKey: value } }
  categories?: string[]
  variant?: BarVariant
  orientation?: BarOrientation
  showLabels?: boolean
  showGrid?: boolean
  showLegend?: boolean
  onHover?: (d: DataPoint | null) => void
}
