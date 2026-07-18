import { useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { DEFAULT_MARGIN, getInnerDimensions } from "../lib/d3Helpers";
import { getColorScheme } from "../lib/colorUtils";
import { categoricalColor, semanticColor } from "../lib/chartRoles";
import { SHAPE_RX } from "../lib/chartStyle";
import { formatNumber, formatDateShort } from "../lib/formatters";
import {
  CHART_TEXT_MUTED,
  CHART_NEGATIVE,
  CHART_POSITIVE,
  CHART_WARNING,
} from "../lib/theme";
import { themeAxis, themeGrid } from "../lib/d3Theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";
import type { LineChartProps, TimeSeriesPoint } from "../lib/types";

const DEFAULT_SERIES_NAMES = ["系列A", "系列B", "系列C", "系列D"];
const SERIES_OFFSETS = [0, 150, -80, 200];

// ゼロ設定でも描画できる既定データ（他チャートと同様）
const DEFAULT_LINE_DATA: TimeSeriesPoint[] = [
  { date: new Date(2026, 0, 1), value: 120 },
  { date: new Date(2026, 1, 1), value: 180 },
  { date: new Date(2026, 2, 1), value: 150 },
  { date: new Date(2026, 3, 1), value: 240 },
  { date: new Date(2026, 4, 1), value: 210 },
  { date: new Date(2026, 5, 1), value: 300 },
];

function buildMultiSeriesData(
  base: TimeSeriesPoint[],
  count: number,
  seriesNames: string[],
): TimeSeriesPoint[] {
  if (count <= 1) return base;
  const result: TimeSeriesPoint[] = [];
  for (let s = 0; s < count; s++) {
    const offset = SERIES_OFFSETS[s] ?? s * 100;
    base.forEach((d) => {
      result.push({
        date: d.date,
        value: Math.max(
          0,
          d.value + offset + Math.round(Math.sin(d.date.getTime() / 1e10 + s) * 50),
        ),
        series: seriesNames[s],
      });
    });
  }
  return result;
}

export function LineChart({
  data = DEFAULT_LINE_DATA,
  series,
  width: propWidth,
  height = 300,
  margin = DEFAULT_MARGIN,
  smooth = false,
  showDots = true,
  showGrid = true,
  animated = true,
  colors: colorsProp,
  className,
  missingData,
  colorScheme,
  customColor,
  lineVariant,
  markerStyle,
  referenceLines,
  showTrendline,
  yAxisMin,
  yAxisMax,
  seriesCount,
  seriesLabels,
  thresholdGood,
  thresholdBad,
  conditionalFormat,
  showDataLabels,
  onPointClick,
  comparisonData,
  showComparison,
  zoomable,
  highlightArea,
  yAxisFormat,
  trendlineType,
  dualYAxis,
  secondaryMetric,
  animationDuration,
  showZeroLine,
}: LineChartProps & {
  colorScheme?: string;
  customColor?: string;
  lineVariant?: "standard" | "stepped" | "smooth-area";
  markerStyle?: "circle" | "square" | "diamond" | "triangle" | "none";
  showTrendline?: boolean;
  trendlineType?: "linear" | "exp" | "poly";
  seriesCount?: number;
  showDataLabels?: boolean;
  onPointClick?: (label: string, value: number) => void;
  comparisonData?: { date: Date; value: number }[];
  showComparison?: boolean;
  zoomable?: boolean;
  highlightArea?: boolean;
  yAxisFormat?: string;
  dualYAxis?: boolean;
  secondaryMetric?: string;
  animationDuration?: number;
  showZeroLine?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { show, hide, tooltipRef } = useTooltip();
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  const width = propWidth ?? observedWidth;
  const { innerWidth, innerHeight } = getInnerDimensions(width, height, margin);

  // M-1: Y axis tick formatter based on yAxisFormat
  function getYAxisTickFormatter(): (v: d3.NumberValue) => string {
    if (!yAxisFormat || yAxisFormat === "default")
      return (v) => formatNumber(v as number, 0);
    return (v: d3.NumberValue) => {
      const n = v as number;
      if (yAxisFormat === "¥#,##0") return "¥" + n.toLocaleString("ja-JP");
      if (yAxisFormat === "0.0%") return (n * 100).toFixed(1) + "%";
      if (yAxisFormat === "0.0K") return (n / 1000).toFixed(1) + "K";
      if (yAxisFormat === "#,##0") return n.toLocaleString("ja-JP");
      return String(n);
    };
  }
  const yTickFormatter = getYAxisTickFormatter();

  // Build multi-series data when seriesCount > 1
  const effectiveCount = seriesCount ?? 1;
  const effectiveSeriesNames =
    seriesLabels && seriesLabels.length > 0 ? seriesLabels : DEFAULT_SERIES_NAMES;
  // useMemo で安定化（毎レンダー新規配列を useD3 deps に載せない）。
  const resolvedData = useMemo(
    () =>
      effectiveCount > 1
        ? buildMultiSeriesData(data, effectiveCount, effectiveSeriesNames)
        : data,
    [data, effectiveCount, effectiveSeriesNames],
  );
  const resolvedSeries = useMemo(
    () =>
      effectiveCount > 1 ? effectiveSeriesNames.slice(0, effectiveCount) : series,
    [effectiveCount, effectiveSeriesNames, series],
  );

  // 多系列 = 真のカテゴリ → categoricalColor(i)。
  // colorScheme/colors は「ユーザーが明示選択した配色」なので優先し、未指定時はロール基準の色に寄せる。
  const schemeColors = getColorScheme(colorScheme, customColor);
  const getColor = (i: number): string =>
    colorScheme
      ? (schemeColors[i % schemeColors.length] ?? categoricalColor(i))
      : (colorsProp?.[i] ?? categoricalColor(i));

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (!resolvedData.length || innerWidth <= 0 || innerHeight <= 0) return;

      svg.attr("width", width).attr("height", height);

      // widthに応じてfont-sizeを動的算出
      const axisFontSize = width > 0 ? Math.max(8, Math.min(12, width / 50)) : 10;

      const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      // Normalize data: handle missing values according to missingData prop.
      // TimeSeriesPoint.value is typed number, but callers may pass null/undefined.
      type RawPoint = { date: Date; value: number | null | undefined; series?: string };
      const rawData = resolvedData as unknown as RawPoint[];

      const normalizedData: TimeSeriesPoint[] = rawData.map((d) => ({
        ...d,
        value: d.value == null && missingData === "zero" ? 0 : (d.value ?? 0),
      }));

      // For 'break' and 'interpolate', keep original nullability for filtering
      const effectiveData =
        missingData === "zero"
          ? normalizedData
          : (rawData as unknown as TimeSeriesPoint[]);

      // series 別グループ化
      const grouped = d3.group(effectiveData, (d) => d.series ?? "default");
      const seriesKeys = resolvedSeries ?? Array.from(grouped.keys());

      // スケール
      const allDates = effectiveData.map((d) => d.date);
      const xScale = d3
        .scaleTime()
        .domain([d3.min(allDates) ?? new Date(), d3.max(allDates) ?? new Date()])
        .range([0, innerWidth]);

      // For y domain, exclude null values
      const validValues = rawData
        .map((d) => (d.value == null && missingData === "zero" ? 0 : d.value))
        .filter((v): v is number => v != null);
      const maxVal = d3.max(validValues) ?? 0;
      const yScale = d3
        .scaleLinear()
        .domain([yAxisMin ?? 0, yAxisMax ?? maxVal * 1.1])
        .nice()
        .range([innerHeight, 0]);

      // Resolve animation duration: 0 = disabled, undefined = default 600ms
      const animDuration = animationDuration !== undefined ? animationDuration : 600;

      // グリッド線
      if (showGrid) {
        const gridG = g
          .append("g")
          .attr("class", "d3-grid")
          .call(
            d3
              .axisLeft(yScale)
              .tickSize(-innerWidth)
              .tickFormat(() => ""),
          );
        themeGrid(gridG);
      }

      // Zero line highlighting
      if (showZeroLine && yScale.domain()[0]! <= 0 && yScale.domain()[1]! >= 0) {
        g.append("line")
          .attr("class", "zero-line")
          .attr("x1", 0)
          .attr("x2", innerWidth)
          .attr("y1", yScale(0))
          .attr("y2", yScale(0))
          .style("stroke", CHART_NEGATIVE)
          .style("stroke-width", 2)
          .style("opacity", 0.7);
      }

      // Threshold background zones (red / yellow / green)
      if (
        conditionalFormat === "zone" &&
        (thresholdGood != null || thresholdBad != null)
      ) {
        const zoneGroup = g.append("g").attr("class", "threshold-zones");

        // Determine effective domain bounds for zones
        const domainTop = yAxisMax ?? maxVal * 1.1;
        const domainBottom = yAxisMin ?? 0;
        const bad = thresholdBad ?? domainBottom;
        const good = thresholdGood ?? domainTop;

        // Red zone: domainBottom to bad
        if (bad > domainBottom) {
          zoneGroup
            .append("rect")
            .attr("x", 0)
            .attr("width", innerWidth)
            .attr("y", yScale(bad))
            .attr("height", yScale(domainBottom) - yScale(bad))
            .attr("fill", CHART_NEGATIVE)
            .attr("fill-opacity", 0.08);
        }

        // Yellow zone: bad to good
        if (good > bad) {
          zoneGroup
            .append("rect")
            .attr("x", 0)
            .attr("width", innerWidth)
            .attr("y", yScale(good))
            .attr("height", yScale(bad) - yScale(good))
            .attr("fill", CHART_WARNING)
            .attr("fill-opacity", 0.1);
        }

        // Green zone: good to domainTop
        if (domainTop > good) {
          zoneGroup
            .append("rect")
            .attr("x", 0)
            .attr("width", innerWidth)
            .attr("y", yScale(domainTop))
            .attr("height", yScale(good) - yScale(domainTop))
            .attr("fill", CHART_POSITIVE)
            .attr("fill-opacity", 0.08);
        }
      }

      // X軸
      const xAxisG = g
        .append("g")
        .attr("class", "x-axis")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(d3.axisBottom(xScale).tickFormat((d) => formatDateShort(d as Date)));
      themeAxis(xAxisG);
      xAxisG
        .selectAll<SVGTextElement, unknown>("text")
        .style("font-size", `${axisFontSize}px`);

      // Y軸
      const yAxisG = g
        .append("g")
        .call(d3.axisLeft(yScale).tickFormat(yTickFormatter));
      themeAxis(yAxisG);
      yAxisG
        .selectAll<SVGTextElement, unknown>("text")
        .style("font-size", `${axisFontSize}px`);

      // curve 設定
      // lineVariant takes priority; 'interpolate' or smooth also affect curve
      const isSmoothArea = lineVariant === "smooth-area";
      const isStepped = lineVariant === "stepped";
      const curveType = isStepped
        ? d3.curveStepAfter
        : isSmoothArea || missingData === "interpolate" || smooth
          ? d3.curveCatmullRom.alpha(0.5)
          : d3.curveLinear;

      // Feature L-3: Area highlight between two series (draw before lines)
      if (highlightArea && seriesKeys.length === 2) {
        const key0 = seriesKeys[0]!;
        const key1 = seriesKeys[1]!;
        const series0 = grouped.get(key0) ?? [];
        const series1 = grouped.get(key1) ?? [];

        // Build a map of date->value for series1 for quick lookup
        const series1Map = new Map<number, number>();
        series1.forEach((d) => {
          const raw = d as unknown as { date: Date; value: number | null | undefined };
          if (raw.value != null) series1Map.set(raw.date.getTime(), raw.value);
        });

        // Build combined points array: for each point in series0, pair with series1 value
        type HighlightPoint = { date: Date; v0: number; v1: number };
        const highlightPoints: HighlightPoint[] = [];
        series0.forEach((d) => {
          const raw = d as unknown as { date: Date; value: number | null | undefined };
          const v1 = series1Map.get(raw.date.getTime());
          if (raw.value != null && v1 != null) {
            highlightPoints.push({ date: raw.date, v0: raw.value, v1 });
          }
        });

        if (highlightPoints.length > 1) {
          // Split into segments where sign (v0 > v1 vs v0 < v1) is consistent
          // We draw two area paths: one for regions where v0 > v1 (green), one where v0 < v1 (red)
          const greenArea = d3
            .area<HighlightPoint>()
            .x((d) => xScale(d.date))
            .y0((d) => yScale(Math.min(d.v0, d.v1)))
            .y1((d) => yScale(Math.max(d.v0, d.v1)))
            .defined((d) => d.v0 >= d.v1)
            .curve(curveType);

          const redArea = d3
            .area<HighlightPoint>()
            .x((d) => xScale(d.date))
            .y0((d) => yScale(Math.min(d.v0, d.v1)))
            .y1((d) => yScale(Math.max(d.v0, d.v1)))
            .defined((d) => d.v0 <= d.v1)
            .curve(curveType);

          g.append("path")
            .datum(highlightPoints)
            .attr("class", "highlight-area-green")
            .attr("fill", semanticColor("positive"))
            .attr("fill-opacity", 0.15)
            .attr("stroke", "none")
            .attr("d", greenArea);

          g.append("path")
            .datum(highlightPoints)
            .attr("class", "highlight-area-red")
            .attr("fill", semanticColor("negative"))
            .attr("fill-opacity", 0.15)
            .attr("stroke", "none")
            .attr("d", redArea);
        }
      }

      // 各系列を描画
      seriesKeys.forEach((key, i) => {
        // H-1: Skip hidden series
        if (hiddenSeries.has(key)) return;

        const seriesRaw = grouped.get(key) ?? [];
        const color = getColor(i);

        if (missingData === "break") {
          // Use defined() to create gaps at null values
          type MaybeNullPoint = {
            date: Date;
            value: number | null | undefined;
            series?: string;
          };
          const rawSeries = seriesRaw as unknown as MaybeNullPoint[];

          const lineGen = d3
            .line<MaybeNullPoint>()
            .defined((d) => d.value != null)
            .x((d) => xScale(d.date))
            .y((d) => yScale(d.value as number))
            .curve(curveType);

          const path = g
            .append("path")
            .datum(rawSeries)
            .attr("class", `line-path line-path-${i}`)
            .attr("fill", "none")
            .attr("stroke-width", 2)
            .attr("stroke", color)
            .attr("d", lineGen);

          if (animated && animDuration > 0) {
            const totalLength =
              (path.node() as SVGPathElement | null)?.getTotalLength() ?? 0;
            path
              .attr("stroke-dasharray", `${totalLength} ${totalLength}`)
              .attr("stroke-dashoffset", totalLength)
              .transition()
              .duration(animDuration)
              .ease(d3.easeLinear)
              .attr("stroke-dashoffset", 0);
          }

          if (markerStyle !== "none" && (showDots || markerStyle != null)) {
            const validSeries = rawSeries.filter(
              (d) => d.value != null,
            ) as TimeSeriesPoint[];
            g.selectAll(`.dot-${i}`)
              .data(validSeries)
              .join("circle")
              .attr("class", `dot-${i}`)
              .attr("cx", (d) => xScale(d.date))
              .attr("cy", (d) => yScale(d.value))
              .attr("r", 3)
              .attr("fill", color)
              .attr("stroke", "white")
              .attr("stroke-width", 1.5)
              .style("cursor", onPointClick ? "pointer" : "default")
              .on("mouseenter", function (event: MouseEvent, d: TimeSeriesPoint) {
                d3.select(this).attr("r", 5);
                show(
                  event,
                  `${key !== "default" ? key + ": " : ""}${formatNumber(d.value, 0)} (${formatDateShort(d.date)})`,
                );
              })
              .on("mouseleave", function () {
                d3.select(this).attr("r", 3);
                hide();
              })
              .on("click", (_: MouseEvent, d: TimeSeriesPoint) => {
                onPointClick?.(formatDateShort(d.date), d.value);
              });
          }
        } else if (missingData === "interpolate") {
          // M-5: Proper linear interpolation — fill null gaps between valid surrounding points
          type MaybeNullPoint = {
            date: Date;
            value: number | null | undefined;
            series?: string;
          };
          const rawSeries = seriesRaw as unknown as MaybeNullPoint[];

          // Build interpolated series: replace each null/undefined with linearly interpolated value
          const interpolatedSeries: TimeSeriesPoint[] = rawSeries.map((d, idx) => {
            if (d.value != null) return { ...d, value: d.value } as TimeSeriesPoint;

            // Find the nearest valid point before and after this index
            let prevIdx = idx - 1;
            while (prevIdx >= 0 && rawSeries[prevIdx]!.value == null) prevIdx--;
            let nextIdx = idx + 1;
            while (nextIdx < rawSeries.length && rawSeries[nextIdx]!.value == null)
              nextIdx++;

            if (prevIdx >= 0 && nextIdx < rawSeries.length) {
              // Both surrounding valid points found — interpolate linearly
              const t0 = rawSeries[prevIdx]!.date.getTime();
              const t1 = rawSeries[nextIdx]!.date.getTime();
              const v0 = rawSeries[prevIdx]!.value as number;
              const v1 = rawSeries[nextIdx]!.value as number;
              const t = d.date.getTime();
              const ratio = t1 !== t0 ? (t - t0) / (t1 - t0) : 0;
              return { ...d, value: v0 + (v1 - v0) * ratio } as TimeSeriesPoint;
            } else if (prevIdx >= 0) {
              // Only preceding valid point — use its value
              return { ...d, value: rawSeries[prevIdx]!.value as number } as TimeSeriesPoint;
            } else if (nextIdx < rawSeries.length) {
              // Only following valid point — use its value
              return { ...d, value: rawSeries[nextIdx]!.value as number } as TimeSeriesPoint;
            } else {
              return { ...d, value: 0 } as TimeSeriesPoint;
            }
          });

          const lineGen = d3
            .line<TimeSeriesPoint>()
            .x((d) => xScale(d.date))
            .y((d) => yScale(d.value))
            .curve(d3.curveCatmullRom.alpha(0.5));

          const path = g
            .append("path")
            .datum(interpolatedSeries)
            .attr("class", `line-path line-path-${i}`)
            .attr("fill", "none")
            .attr("stroke-width", 2)
            .attr("stroke", color)
            .attr("d", lineGen);

          if (animated && animDuration > 0) {
            const totalLength =
              (path.node() as SVGPathElement | null)?.getTotalLength() ?? 0;
            path
              .attr("stroke-dasharray", `${totalLength} ${totalLength}`)
              .attr("stroke-dashoffset", totalLength)
              .transition()
              .duration(animDuration)
              .ease(d3.easeLinear)
              .attr("stroke-dashoffset", 0);
          }

          if (markerStyle !== "none" && (showDots || markerStyle != null)) {
            // Only show dots on the originally-valid points (not interpolated gaps)
            const originallyValid = interpolatedSeries.filter(
              (_d, idx) => rawSeries[idx]!.value != null,
            );
            g.selectAll(`.dot-${i}`)
              .data(originallyValid)
              .join("circle")
              .attr("class", `dot-${i}`)
              .attr("cx", (d) => xScale(d.date))
              .attr("cy", (d) => yScale(d.value))
              .attr("r", 3)
              .attr("fill", color)
              .attr("stroke", "white")
              .attr("stroke-width", 1.5)
              .style("cursor", onPointClick ? "pointer" : "default")
              .on("mouseenter", function (event: MouseEvent, d: TimeSeriesPoint) {
                d3.select(this).attr("r", 5);
                show(
                  event,
                  `${key !== "default" ? key + ": " : ""}${formatNumber(d.value, 0)} (${formatDateShort(d.date)})`,
                );
              })
              .on("mouseleave", function () {
                d3.select(this).attr("r", 3);
                hide();
              })
              .on("click", (_: MouseEvent, d: TimeSeriesPoint) => {
                onPointClick?.(formatDateShort(d.date), d.value);
              });
          }
        } else {
          // Standard / zero mode: use normalized data (nulls already converted to 0 if needed)
          const seriesPoints = seriesRaw as TimeSeriesPoint[];

          // smooth-area: render filled area below the line（Area と同じ縦グラデ 0.18→0）
          if (isSmoothArea) {
            const areaGen = d3
              .area<TimeSeriesPoint>()
              .x((d) => xScale(d.date))
              .y0(innerHeight)
              .y1((d) => yScale(d.value))
              .curve(curveType);

            const grad = svg
              .select("defs")
              .empty()
              ? svg.append("defs")
              : svg.select<SVGDefsElement>("defs");
            const gradId = `line-area-grad-${i}`;
            const lg = grad
              .append("linearGradient")
              .attr("id", gradId)
              .attr("x1", "0")
              .attr("y1", "0")
              .attr("x2", "0")
              .attr("y2", "1");
            lg.append("stop")
              .attr("offset", "0%")
              .attr("stop-color", color)
              .attr("stop-opacity", 0.18);
            lg.append("stop")
              .attr("offset", "100%")
              .attr("stop-color", color)
              .attr("stop-opacity", 0);

            g.append("path")
              .datum(seriesPoints)
              .attr("class", "chart-area")
              .attr("fill", `url(#${gradId})`)
              .attr("stroke", "none")
              .attr("d", areaGen);
          }

          const lineGen = d3
            .line<TimeSeriesPoint>()
            .x((d) => xScale(d.date))
            .y((d) => yScale(d.value))
            .curve(curveType);

          const path = g
            .append("path")
            .datum(seriesPoints)
            .attr("class", `line-path line-path-${i}`)
            .attr("fill", "none")
            .attr("stroke-width", 2)
            .attr("stroke", color)
            .attr("d", lineGen);

          if (animated && animDuration > 0) {
            const totalLength =
              (path.node() as SVGPathElement | null)?.getTotalLength() ?? 0;
            path
              .attr("stroke-dasharray", `${totalLength} ${totalLength}`)
              .attr("stroke-dashoffset", totalLength)
              .transition()
              .duration(animDuration)
              .ease(d3.easeLinear)
              .attr("stroke-dashoffset", 0);
          }

          const effectiveShowDots =
            markerStyle !== "none" && (showDots || markerStyle != null);
          if (effectiveShowDots) {
            const dotSel = g
              .selectAll(`.dot-${i}`)
              .data(seriesPoints)
              .join("circle")
              .attr("class", `dot-${i}`)
              .style("cursor", "pointer")
              .attr("cx", (d) => xScale(d.date))
              .attr("cy", (d) => yScale(d.value))
              .attr("r", markerStyle === "diamond" || markerStyle === "triangle" ? 4 : 3)
              .attr("fill", color)
              .attr("stroke", "white")
              .attr("stroke-width", 1.5)
              .style("cursor", onPointClick ? "pointer" : "default")
              .on("mouseenter", function (event: MouseEvent, d: TimeSeriesPoint) {
                d3.select(this).attr("r", 5);
                show(
                  event,
                  `${key !== "default" ? key + ": " : ""}${formatNumber(d.value, 0)} (${formatDateShort(d.date)})`,
                );
              })
              .on("mouseleave", function () {
                d3.select(this).attr(
                  "r",
                  markerStyle === "diamond" || markerStyle === "triangle" ? 4 : 3,
                );
                hide();
              })
              .on("click", (_: MouseEvent, d: TimeSeriesPoint) => {
                onPointClick?.(formatDateShort(d.date), d.value);
              });

            // Apply shape transforms for non-circle markers
            if (markerStyle === "square") {
              dotSel.attr("rx", 0).attr("ry", 0);
            } else if (markerStyle === "diamond") {
              dotSel
                .attr(
                  "transform",
                  (d) => `translate(${xScale(d.date)},${yScale(d.value)}) rotate(45)`,
                )
                .attr("cx", 0)
                .attr("cy", 0);
            }
          }

          // データラベル（showDataLabels === true のとき）
          if (showDataLabels) {
            const visiblePoints = seriesPoints.filter((_d, idx) => {
              if (seriesPoints.length > 12)
                return idx % Math.ceil(seriesPoints.length / 8) === 0;
              return true;
            });
            g.selectAll(`.data-label-${i}`)
              .data(visiblePoints)
              .join("text")
              .attr("class", `data-label-${i}`)
              .attr("x", (d) => xScale(d.date))
              .attr("y", (d) => yScale(d.value) - 8)
              .attr("text-anchor", "middle")
              .attr("font-size", "10px")
              .attr("fill", CHART_TEXT_MUTED)
              .text((d) => d.value.toLocaleString("ja-JP"));
          }
        }
      });

      // Reference Lines
      if (referenceLines && referenceLines.length > 0) {
        const refGroup = g.append("g").attr("class", "reference-lines");
        referenceLines.forEach((ref) => {
          const y = yScale(ref.value);
          if (isNaN(y)) return;
          refGroup
            .append("line")
            .attr("x1", 0)
            .attr("x2", innerWidth)
            .attr("y1", y)
            .attr("y2", y)
            .attr("stroke", ref.color ?? CHART_NEGATIVE)
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", ref.style === "solid" ? "none" : "4 4");
          if (ref.label) {
            refGroup
              .append("text")
              .attr("x", innerWidth - 2)
              .attr("y", y - 4)
              .attr("text-anchor", "end")
              .attr("font-size", "10px")
              .attr("fill", ref.color ?? CHART_NEGATIVE)
              .text(ref.label);
          }
        });
      }

      // Trendline (#5: trendlineType 対応)
      if (showTrendline && resolvedData.length >= 2) {
        const yVals = resolvedData.map((d) => d.value);
        const n = resolvedData.length;
        const effectiveTrendType = trendlineType ?? "linear";

        // 共通: X を 0..n-1 のインデックスで扱う
        const sumX = (n * (n - 1)) / 2;
        const sumY = yVals.reduce((a, b) => a + b, 0);
        const sumXY = yVals.reduce((s, y, i) => s + i * y, 0);
        const sumXX = (n * (n - 1) * (2 * n - 1)) / 6;

        if (effectiveTrendType === "linear") {
          // y = ax + b
          const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
          const intercept = (sumY - slope * sumX) / n;
          g.append("line")
            .attr("x1", xScale(resolvedData[0]!.date))
            .attr("x2", xScale(resolvedData[n - 1]!.date))
            .attr("y1", yScale(intercept))
            .attr("y2", yScale(slope * (n - 1) + intercept))
            .attr("stroke", CHART_NEGATIVE)
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", "6 3")
            .attr("opacity", 0.75)
            .attr("pointer-events", "none");
          g.append("text")
            .attr("x", xScale(resolvedData[n - 1]!.date) + 4)
            .attr("y", yScale(slope * (n - 1) + intercept))
            .attr("font-size", "9px")
            .attr("fill", CHART_NEGATIVE)
            .attr("opacity", 0.8)
            .text("線形");
        } else if (effectiveTrendType === "exp") {
          // y = a * e^(bx) — log変換して線形回帰
          const logVals = yVals.map((v) => (v > 0 ? Math.log(v) : 0));
          const sumLogY = logVals.reduce((a, b) => a + b, 0);
          const sumXLogY = logVals.reduce((s, lv, i) => s + i * lv, 0);
          const bExp = (n * sumXLogY - sumX * sumLogY) / (n * sumXX - sumX * sumX);
          const logA = (sumLogY - bExp * sumX) / n;
          const aExp = Math.exp(logA);
          const expPoints = resolvedData.map((d, i) => ({
            date: d.date,
            val: aExp * Math.exp(bExp * i),
          }));
          const expLine = d3
            .line<{ date: Date; val: number }>()
            .x((d) => xScale(d.date))
            .y((d) => yScale(d.val));
          g.append("path")
            .datum(expPoints)
            .attr("fill", "none")
            .attr("stroke", CHART_NEGATIVE)
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", "6 3")
            .attr("opacity", 0.75)
            .attr("pointer-events", "none")
            .attr("d", expLine);
          g.append("text")
            .attr("x", xScale(resolvedData[n - 1]!.date) + 4)
            .attr("y", yScale(expPoints[n - 1]!.val))
            .attr("font-size", "9px")
            .attr("fill", CHART_NEGATIVE)
            .attr("opacity", 0.8)
            .text("指数");
        } else if (effectiveTrendType === "poly") {
          // y = ax² + bx + c (2次回帰)
          const sumX2 = yVals.reduce((s, _v, i) => s + i * i, 0);
          const sumX3 = yVals.reduce((s, _v, i) => s + i * i * i, 0);
          const sumX4 = yVals.reduce((s, _v, i) => s + i * i * i * i, 0);
          const sumX2Y = yVals.reduce((s, v, i) => s + i * i * v, 0);
          // Solve 3x3 system using Cramer's rule: [n, sumX, sumX2; sumX, sumX2, sumX3; sumX2, sumX3, sumX4] * [c, b, a] = [sumY, sumXY, sumX2Y]
          const mat = [
            [n, sumX, sumX2],
            [sumX, sumX2, sumX3],
            [sumX2, sumX3, sumX4],
          ];
          const vec = [sumY, sumXY, sumX2Y];
          // Gaussian elimination
          const m = mat.map((row, i) => [...row, vec[i]!]);
          for (let col = 0; col < 3; col++) {
            const pivot = m[col]![col]!;
            if (Math.abs(pivot) < 1e-10) continue;
            for (let row = col + 1; row < 3; row++) {
              const factor = m[row]![col]! / pivot;
              for (let k = col; k <= 3; k++) m[row]![k]! -= factor * m[col]![k]!;
            }
          }
          const polyC = [0, 0, 0];
          for (let i = 2; i >= 0; i--) {
            let sum = m[i]![3]!;
            for (let j = i + 1; j < 3; j++) sum -= m[i]![j]! * polyC[j]!;
            polyC[i] = Math.abs(m[i]![i]!) > 1e-10 ? sum / m[i]![i]! : 0;
          }
          const [cCoef, bCoef, aCoef] = polyC as [number, number, number];
          const polyPoints = resolvedData.map((d, i) => ({
            date: d.date,
            val: aCoef * i * i + bCoef * i + cCoef,
          }));
          const polyLine = d3
            .line<{ date: Date; val: number }>()
            .x((d) => xScale(d.date))
            .y((d) => yScale(d.val));
          g.append("path")
            .datum(polyPoints)
            .attr("fill", "none")
            .attr("stroke", CHART_NEGATIVE)
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", "6 3")
            .attr("opacity", 0.75)
            .attr("pointer-events", "none")
            .attr("d", polyLine);
          g.append("text")
            .attr("x", xScale(resolvedData[n - 1]!.date) + 4)
            .attr("y", yScale(polyPoints[n - 1]!.val))
            .attr("font-size", "9px")
            .attr("fill", CHART_NEGATIVE)
            .attr("opacity", 0.8)
            .text("多項式");
        }
      }

      // #6 デュアルY軸: secondaryMetric 系列を右軸にバインド
      if (dualYAxis && secondaryMetric) {
        const secondarySeriesData = grouped.get(secondaryMetric) ?? [];
        const secondaryValues = secondarySeriesData
          .map((d) => (d as unknown as { value: number | null | undefined }).value)
          .filter((v): v is number => v != null);
        const maxSecondary = d3.max(secondaryValues) ?? 0;
        const yScaleRight = d3
          .scaleLinear()
          .domain([0, maxSecondary * 1.1])
          .nice()
          .range([innerHeight, 0]);

        // 右軸を描画
        const rightAxisG = g
          .append("g")
          .attr("class", "axis-right")
          .attr("transform", `translate(${innerWidth}, 0)`)
          .call(d3.axisRight(yScaleRight).tickFormat((v) => formatNumber(v as number, 0)));
        themeAxis(rightAxisG);
        rightAxisG
          .selectAll<SVGTextElement, unknown>("text")
          .style("font-size", `${Math.max(8, Math.min(12, width / 50))}px`)
          .style("fill", CHART_NEGATIVE);

        // 右軸の系列ラインを右スケールで再描画
        const secondaryPoints = secondarySeriesData as TimeSeriesPoint[];
        const secondaryIdx = seriesKeys.indexOf(secondaryMetric);
        const secondaryColor = secondaryIdx >= 0 ? getColor(secondaryIdx) : CHART_NEGATIVE;
        const rightLineGen = d3
          .line<TimeSeriesPoint>()
          .x((d) => xScale(d.date))
          .y((d) => yScaleRight(d.value))
          .curve(curveType);
        g.append("path")
          .datum(secondaryPoints)
          .attr("class", "line-path-right")
          .attr("fill", "none")
          .attr("stroke", secondaryColor)
          .attr("stroke-width", 2)
          .attr("d", rightLineGen)
          .attr("pointer-events", "none");
      }

      // 比較ライン（前期データ）
      if (showComparison && comparisonData && comparisonData.length > 0) {
        const compLineGen = d3
          .line<{ date: Date; value: number }>()
          .x((d) => xScale(d.date))
          .y((d) => yScale(d.value))
          .curve(curveType);

        g.append("path")
          .datum(comparisonData)
          .attr("class", "comparison-line")
          .attr("fill", "none")
          .attr("stroke-width", 2)
          .attr("stroke", CHART_TEXT_MUTED)
          .attr("stroke-dasharray", "4,4")
          .attr("opacity", 0.8)
          .attr("d", compLineGen);
      }

      // 透明オーバーレイ：マウス位置トラッキング
      g.append("rect")
        .attr("width", innerWidth)
        .attr("height", innerHeight)
        .attr("fill", "transparent")
        .on("mousemove", function (event: MouseEvent) {
          const [mx] = d3.pointer(event);
          const hoverDate = xScale.invert(mx);
          // 最近傍データポイントを探す（null値は除外）
          let closest: TimeSeriesPoint | null = null;
          let minDist = Infinity;
          const dataToSearch =
            missingData === "break" || missingData === "interpolate"
              ? ((resolvedData as unknown as Array<{
                  date: Date;
                  value: number | null | undefined;
                  series?: string;
                }>).filter((d) => d.value != null) as unknown as TimeSeriesPoint[])
              : resolvedData;
          dataToSearch.forEach((d) => {
            const dist = Math.abs(d.date.getTime() - hoverDate.getTime());
            if (dist < minDist) {
              minDist = dist;
              closest = d;
            }
          });
          if (closest) {
            const c = closest as TimeSeriesPoint;
            const seriesLabel = c.series && c.series !== "default" ? `${c.series}: ` : "";
            show(event, `${seriesLabel}${formatNumber(c.value, 0)} (${formatDateShort(c.date)})`);
          }
        })
        .on("mouseleave", () => hide());

      // 凡例（複数系列 または 比較モードの場合）
      const showLegendForComparison =
        showComparison && comparisonData && comparisonData.length > 0;
      if (
        (seriesKeys.length > 1 && seriesKeys[0] !== "default") ||
        showLegendForComparison
      ) {
        const legend = svg
          .append("g")
          .attr("transform", `translate(${margin.left}, ${height - margin.bottom + 30})`);

        if (showLegendForComparison && seriesKeys.length <= 1) {
          // 比較モード専用凡例（当期・前期）
          const currentColor = getColor(0);
          const legendItems = [
            { label: "当期", color: currentColor, dashed: false },
            { label: "前期", color: CHART_TEXT_MUTED, dashed: true },
          ];
          legendItems.forEach(({ label, color, dashed }, idx) => {
            const item = legend
              .append("g")
              .attr("transform", `translate(${idx * 80}, 0)`);

            if (dashed) {
              item
                .append("line")
                .attr("x1", 0)
                .attr("y1", 5)
                .attr("x2", 10)
                .attr("y2", 5)
                .attr("stroke", color)
                .attr("stroke-width", 2)
                .attr("stroke-dasharray", "4,2");
            } else {
              item
                .append("rect")
                .attr("width", 10)
                .attr("height", 10)
                .attr("fill", color)
                .attr("rx", SHAPE_RX);
            }

            item
              .append("text")
              .attr("x", 14)
              .attr("y", 9)
              .attr("font-size", "11px")
              .attr("fill", CHART_TEXT_MUTED)
              .text(label);
          });
        } else {
          seriesKeys.forEach((key, i) => {
            const color = getColor(i);
            const isHidden = hiddenSeries.has(key);
            const item = legend
              .append("g")
              .attr("transform", `translate(${i * 100}, 0)`)
              .attr("opacity", isHidden ? 0.4 : 1)
              .style("cursor", "pointer")
              .on("click", () => {
                setHiddenSeries((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                  return next;
                });
              });

            item
              .append("rect")
              .attr("width", 10)
              .attr("height", 10)
              .attr("fill", color)
              .attr("rx", SHAPE_RX);

            item
              .append("text")
              .attr("x", 14)
              .attr("y", 9)
              .attr("font-size", "11px")
              .attr("fill", CHART_TEXT_MUTED)
              .attr("text-decoration", isHidden ? "line-through" : "none")
              .text(key);
          });
        }
      }

      // ズーム（zoomable=true の場合）
      if (zoomable) {
        const zoom = d3
          .zoom<SVGSVGElement, unknown>()
          .scaleExtent([1, 10])
          .translateExtent([
            [0, 0],
            [width, height],
          ])
          .extent([
            [0, 0],
            [width, height],
          ])
          .on("zoom", (event) => {
            const newXScale = event.transform.rescaleX(xScale);

            // X軸を更新
            const zXAxis = svg.select<SVGGElement>(".x-axis");
            zXAxis.call(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              d3.axisBottom(newXScale).tickFormat((d) => formatDateShort(d as Date)) as any,
            );
            zXAxis
              .selectAll<SVGTextElement, unknown>("text")
              .style("font-size", `${axisFontSize}px`);

            // 当期ラインパスを更新（line-path クラス付き全系列）
            const newLine = d3
              .line<TimeSeriesPoint>()
              .x((d) => newXScale(d.date))
              .y((d) => yScale(d.value))
              .curve(curveType);

            svg.selectAll<SVGPathElement, TimeSeriesPoint[]>(".line-path").attr("d", newLine);

            // 比較ラインを更新
            if (showComparison && comparisonData && comparisonData.length > 0) {
              const newCompLine = d3
                .line<{ date: Date; value: number }>()
                .x((d) => newXScale(d.date))
                .y((d) => yScale(d.value))
                .curve(curveType);
              svg
                .select<SVGPathElement>(".comparison-line")
                .datum(comparisonData)
                .attr("d", newCompLine);
            }
          });

        svg.call(zoom);
        // ダブルクリックでズームリセット
        svg.on("dblclick.zoom", () =>
          svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity),
        );
      }
    },
    [
      resolvedData,
      resolvedSeries,
      width,
      height,
      smooth,
      showDots,
      showGrid,
      animated,
      innerWidth,
      innerHeight,
      missingData,
      colorScheme,
      lineVariant,
      markerStyle,
      referenceLines,
      showTrendline,
      trendlineType,
      yAxisMin,
      yAxisMax,
      seriesCount,
      thresholdGood,
      thresholdBad,
      conditionalFormat,
      showDataLabels,
      onPointClick,
      comparisonData,
      showComparison,
      zoomable,
      hiddenSeries,
      highlightArea,
      yAxisFormat,
      dualYAxis,
      secondaryMetric,
      animationDuration,
      showZeroLine,
    ],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
      style={{ position: "relative" }}
    >
      <svg
        ref={svgRef}
        role="img"
        aria-label={`折れ線グラフ: ${resolvedSeries ? resolvedSeries.join(", ") : "系列データ"}`}
      />
      <ChartTooltip ref={tooltipRef} />
    </div>
  );
}
