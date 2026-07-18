import { useRef, useState } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { DEFAULT_MARGIN, getInnerDimensions } from "../lib/d3Helpers";
import { getChartColor, getColorScheme } from "../lib/colorUtils";
import { formatNumber, applyNumberFormat } from "../lib/formatters";
import {
  CHART_TEXT_MUTED,
  CHART_BORDER,
  CHART_POSITIVE,
  CHART_NEGATIVE,
  CHART_WARNING,
} from "../lib/theme";
import { themeAxis, themeGrid } from "../lib/d3Theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";
import type { MultiBarChartProps, BarSeries } from "../lib/types";

function formatTooltip(
  label: string,
  value: number,
  prefix: string,
  suffix: string,
  template?: string,
): string {
  if (template) {
    return template
      .replace("{{label}}", label)
      .replace("{{value}}", String(value))
      .replace("{{prefix}}", prefix)
      .replace("{{suffix}}", suffix);
  }
  return `${label}: ${prefix}${value.toLocaleString()}${suffix}`;
}

export function BarChart({
  data,
  series,
  seriesData,
  categories,
  variant,
  width: propWidth,
  height = 300,
  margin = DEFAULT_MARGIN,
  orientation = "vertical",
  showLabels = false,
  showGrid = true,
  showLegend = false,
  animated = true,
  onHover,
  onBarClick,
  className,
  colorScheme,
  customColor,
  labelPosition,
  sortOrder,
  limitRows,
  numberFormat,
  referenceLines,
  thresholdGood,
  thresholdBad,
  conditionalFormat,
  stackMode,
  showDataLabels,
  yAxisFormat,
  tooltipPrefix = "",
  tooltipSuffix = "",
  tooltipTemplate,
  animationDuration,
  showZeroLine,
}: MultiBarChartProps & {
  onBarClick?: (label: string) => void;
  colorScheme?: string;
  customColor?: string;
  labelPosition?: "inside" | "outside" | "above" | "none";
  sortOrder?: "none" | "asc" | "desc";
  limitRows?: number;
  numberFormat?: "auto" | "compact" | "comma" | "percent";
  referenceLines?: Array<{
    value: number;
    label?: string;
    color?: string;
    style?: "solid" | "dashed";
  }>;
  thresholdGood?: number;
  thresholdBad?: number;
  conditionalFormat?: string;
  stackMode?: "absolute" | "percent";
  showDataLabels?: boolean;
  yAxisFormat?: string;
  tooltipPrefix?: string;
  tooltipSuffix?: string;
  tooltipTemplate?: string;
  animationDuration?: number;
  showZeroLine?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { state: tooltipState, show, hide } = useTooltip();
  // H-1: hidden series state for legend click toggle
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  const width = propWidth ?? observedWidth;
  const { innerWidth, innerHeight } = getInnerDimensions(width, height, margin);

  // Resolve color scheme
  const schemeColors = getColorScheme(colorScheme, customColor);
  const getColor = (i: number): string =>
    schemeColors[i % schemeColors.length] ?? getChartColor(i);

  // Conditional formatting helpers
  // Mode 'bar': color each bar by value vs thresholds
  const getThresholdColor = (value: number, defaultColor: string): string => {
    if (thresholdGood != null && value >= thresholdGood) return CHART_POSITIVE;
    if (thresholdBad != null && value < thresholdBad) return CHART_NEGATIVE;
    if (thresholdBad != null && thresholdGood != null) return CHART_WARNING;
    return defaultColor;
  };

  // Returns the bar fill: either a threshold color, a gradient URL, or the default color

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

  // Resolve effective variant: if only `data` is provided and no variant given, default to 'single'
  const effectiveVariant = variant ?? (data && !series ? "single" : "grouped");

  // Resolve series keys and color helpers
  const resolvedSeries: BarSeries[] = series ?? [];
  const seriesKeys = resolvedSeries.map((s) => s.key);

  // Resolve categories from prop or derive from seriesData keys
  const resolvedCategories: string[] =
    categories ??
    (seriesData ? Object.keys(seriesData) : data ? data.map((d) => d.label) : []);

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      const hasData =
        effectiveVariant === "single"
          ? data && data.length > 0
          : resolvedCategories.length > 0 && seriesKeys.length > 0 && seriesData;

      if (!hasData || innerWidth <= 0 || innerHeight <= 0) return;

      svg.attr("width", width).attr("height", height);

      // Resolve animation duration: 0 = disabled, undefined = default 600ms
      const animDuration = animationDuration !== undefined ? animationDuration : 600;

      // widthに応じてfont-sizeを動的算出
      const axisFontSize = width > 0 ? Math.max(8, Math.min(12, width / 50)) : 10;

      const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      // ------------------------------------------------------------------ //
      // SINGLE variant (original behavior, vertical and horizontal)
      // ------------------------------------------------------------------ //
      if (effectiveVariant === "single" && data) {
        // Apply sort and limit to data
        let displayData = data ? [...data] : [];
        if (sortOrder === "asc") displayData.sort((a, b) => a.value - b.value);
        else if (sortOrder === "desc") displayData.sort((a, b) => b.value - a.value);
        if (limitRows && limitRows > 0) displayData = displayData.slice(0, limitRows);

        // Compute highlight-top set
        const highlightTopN =
          conditionalFormat === "highlight-top" ? Math.max(1, limitRows ?? 3) : 0;
        const topValues =
          highlightTopN > 0
            ? new Set(
                [...displayData]
                  .sort((a, b) => b.value - a.value)
                  .slice(0, highlightTopN)
                  .map((d) => d.label),
              )
            : null;

        if (orientation === "vertical") {
          const xScale = d3
            .scaleBand()
            .domain(displayData.map((d) => d.label))
            .range([0, innerWidth])
            .padding(0.25);

          const maxVal = d3.max(displayData, (d) => d.value) ?? 0;
          const yScale = d3
            .scaleLinear()
            .domain([0, maxVal])
            .nice()
            .range([innerHeight, 0]);

          if (showGrid) {
            const gridG = g
              .append("g")
              .call(
                d3
                  .axisLeft(yScale)
                  .tickSize(-innerWidth)
                  .tickFormat(() => ""),
              );
            themeGrid(gridG);
          }

          // Zero line highlighting (vertical single bar)
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

          const xAxisG = g
            .append("g")
            .attr("transform", `translate(0,${innerHeight})`)
            .call(d3.axisBottom(xScale));
          themeAxis(xAxisG);
          xAxisG.selectAll<SVGTextElement, unknown>("text").style("font-size", `${axisFontSize}px`);
          if (width < 300) {
            xAxisG
              .selectAll<SVGTextElement, unknown>("text")
              .attr("transform", "rotate(-45)")
              .attr("text-anchor", "end")
              .attr("dx", "-0.5em")
              .attr("dy", "0.5em");
          }

          const yAxisG = g
            .append("g")
            .call(d3.axisLeft(yScale).tickFormat(yTickFormatter));
          themeAxis(yAxisG);
          yAxisG.selectAll<SVGTextElement, unknown>("text").style("font-size", `${axisFontSize}px`);

          // --- Gradient defs: 既定で単一hueの縦グラデ（根元やや淡→先端濃）で深みを出す＝ベタ塗り回避。
          //     単一指標の棒は「棒ごと別色（虹色）」にせず単色 getColor(0) に統一（カテゴリ誤読の回避）。 ---
          {
            const defs = svg.append("defs");
            displayData.forEach((d, i) => {
              const baseColor = d.color ?? getColor(0);
              const grad = defs
                .append("linearGradient")
                .attr("id", `bar-grad-${i}`)
                .attr("x1", "0")
                .attr("y1", "1")
                .attr("x2", "0")
                .attr("y2", "0");
              grad
                .append("stop")
                .attr("offset", "0%")
                .attr("stop-color", baseColor)
                .attr("stop-opacity", 0.78);
              grad
                .append("stop")
                .attr("offset", "100%")
                .attr("stop-color", baseColor)
                .attr("stop-opacity", 1);
            });
          }

          const bars = g
            .selectAll<SVGRectElement, (typeof displayData)[number]>(".bar")
            .data(displayData)
            .join("rect")
            .attr("class", "bar")
            .style("cursor", "pointer")
            .attr("x", (d) => xScale(d.label) ?? 0)
            .attr("width", xScale.bandwidth())
            .attr("rx", 4)
            .attr("fill", (d, i) => {
              if (conditionalFormat === "highlight-top") {
                return topValues?.has(d.label) ? getChartColor(0) : CHART_BORDER;
              }
              if (conditionalFormat === "bar")
                return getThresholdColor(d.value, d.color ?? getColor(0));
              return d.color ?? `url(#bar-grad-${i})`;
            })
            .attr("y", innerHeight)
            .attr("height", 0);

          if (animDuration > 0) {
            bars
              .transition()
              .duration(animDuration)
              .ease(d3.easeQuadOut)
              .attr("y", (d) => yScale(d.value))
              .attr("height", (d) => innerHeight - yScale(d.value));
          } else {
            bars
              .attr("y", (d) => yScale(d.value))
              .attr("height", (d) => innerHeight - yScale(d.value));
          }

          const effectiveLabelPosition =
            labelPosition ?? (showLabels ? "outside" : "none");
          if (effectiveLabelPosition !== "none") {
            g.selectAll(".bar-label")
              .data(displayData)
              .join("text")
              .attr("class", "bar-label")
              .attr("x", (d) => (xScale(d.label) ?? 0) + xScale.bandwidth() / 2)
              .attr("y", (d) => {
                if (effectiveLabelPosition === "inside") return yScale(d.value) + 14;
                // 'outside' | 'above'
                return yScale(d.value) - 4;
              })
              .attr("text-anchor", "middle")
              .attr("font-size", "11px")
              .attr("fill", CHART_TEXT_MUTED)
              .text((d) => applyNumberFormat(d.value, numberFormat));
          }

          // M-5: showDataLabels for single vertical bar
          if (showDataLabels) {
            g.selectAll<SVGTextElement, (typeof displayData)[number]>(
              ".data-label-single-v",
            )
              .data(displayData)
              .join("text")
              .attr("class", "data-label-single-v")
              .attr("x", (d) => (xScale(d.label) ?? 0) + xScale.bandwidth() / 2)
              .attr("y", (d) => {
                const barHeight = innerHeight - yScale(d.value);
                if (barHeight < 20) return -9999;
                return yScale(d.value) - 4;
              })
              .attr("text-anchor", "middle")
              .attr("font-size", "10px")
              .attr("fill", CHART_TEXT_MUTED)
              .attr("pointer-events", "none")
              .text((d) => applyNumberFormat(d.value, numberFormat));
          }

          bars
            .on("mouseenter", function (event: MouseEvent, d) {
              d3.select(this).attr("opacity", 0.8);
              show(
                event,
                formatTooltip(
                  d.label,
                  d.value,
                  tooltipPrefix,
                  tooltipSuffix,
                  tooltipTemplate,
                ),
              );
              onHover?.(d);
            })
            .on("mouseleave", function () {
              d3.select(this).attr("opacity", 1);
              hide();
              onHover?.(null);
            })
            .on("click", (_, d) => onBarClick?.(d.label));

          // Reference Lines (vertical bar)
          if (referenceLines && referenceLines.length > 0) {
            const refGroup = g.append("g").attr("class", "reference-lines");
            referenceLines.forEach((ref) => {
              const y = yScale(ref.value);
              if (y == null || isNaN(y)) return;
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
        } else {
          // horizontal single
          const maxVal = d3.max(displayData, (d) => d.value) ?? 0;
          const xScale = d3
            .scaleLinear()
            .domain([0, maxVal])
            .nice()
            .range([0, innerWidth]);

          const yScale = d3
            .scaleBand()
            .domain(displayData.map((d) => d.label))
            .range([0, innerHeight])
            .padding(0.25);

          if (showGrid) {
            const gridG = g
              .append("g")
              .call(
                d3
                  .axisBottom(xScale)
                  .tickSize(innerHeight)
                  .tickFormat(() => ""),
              )
              .attr("transform", `translate(0,0)`);
            themeGrid(gridG);
          }

          const xAxisG = g
            .append("g")
            .attr("transform", `translate(0,${innerHeight})`)
            .call(d3.axisBottom(xScale).tickFormat((d) => formatNumber(d as number, 0)));
          themeAxis(xAxisG);
          xAxisG.selectAll<SVGTextElement, unknown>("text").style("font-size", `${axisFontSize}px`);

          const yAxisG = g.append("g").call(d3.axisLeft(yScale));
          themeAxis(yAxisG);
          yAxisG.selectAll<SVGTextElement, unknown>("text").style("font-size", `${axisFontSize}px`);

          // --- Gradient defs（既定・横: 左やや淡→右濃）。単一指標は単色 getColor(0) に統一。 ---
          {
            const defsH = svg.append("defs");
            displayData.forEach((d, i) => {
              const baseColor = d.color ?? getColor(0);
              const grad = defsH
                .append("linearGradient")
                .attr("id", `bar-grad-h-${i}`)
                .attr("x1", "0")
                .attr("y1", "0")
                .attr("x2", "1")
                .attr("y2", "0");
              grad
                .append("stop")
                .attr("offset", "0%")
                .attr("stop-color", baseColor)
                .attr("stop-opacity", 0.78);
              grad
                .append("stop")
                .attr("offset", "100%")
                .attr("stop-color", baseColor)
                .attr("stop-opacity", 1);
            });
          }

          const bars = g
            .selectAll<SVGRectElement, (typeof displayData)[number]>(".bar")
            .data(displayData)
            .join("rect")
            .attr("class", "bar")
            .style("cursor", "pointer")
            .attr("y", (d) => yScale(d.label) ?? 0)
            .attr("height", yScale.bandwidth())
            .attr("rx", 4)
            .attr("fill", (d, i) => {
              if (conditionalFormat === "highlight-top") {
                return topValues?.has(d.label) ? getChartColor(0) : CHART_BORDER;
              }
              if (conditionalFormat === "bar")
                return getThresholdColor(d.value, d.color ?? getColor(0));
              return d.color ?? `url(#bar-grad-h-${i})`;
            })
            .attr("x", 0)
            .attr("width", 0);

          if (animDuration > 0) {
            bars
              .transition()
              .duration(animDuration)
              .ease(d3.easeQuadOut)
              .attr("width", (d) => xScale(d.value));
          } else {
            bars.attr("width", (d) => xScale(d.value));
          }

          const effectiveLabelPositionH =
            labelPosition ?? (showLabels ? "outside" : "none");
          if (effectiveLabelPositionH !== "none") {
            g.selectAll(".bar-label")
              .data(displayData)
              .join("text")
              .attr("class", "bar-label")
              .attr("x", (d) => {
                if (effectiveLabelPositionH === "inside") return xScale(d.value) - 4;
                // 'outside' | 'above'
                return xScale(d.value) + 4;
              })
              .attr("y", (d) => (yScale(d.label) ?? 0) + yScale.bandwidth() / 2)
              .attr("dominant-baseline", "middle")
              .attr("text-anchor", effectiveLabelPositionH === "inside" ? "end" : "start")
              .attr("font-size", "11px")
              .attr("fill", CHART_TEXT_MUTED)
              .text((d) => applyNumberFormat(d.value, numberFormat));
          }

          // M-5: showDataLabels for single horizontal bar
          if (showDataLabels) {
            g.selectAll<SVGTextElement, (typeof displayData)[number]>(
              ".data-label-single-h",
            )
              .data(displayData)
              .join("text")
              .attr("class", "data-label-single-h")
              .attr("x", (d) => {
                const barWidth = xScale(d.value);
                if (barWidth < 20) return xScale(d.value) + 4;
                return xScale(d.value) - 4;
              })
              .attr("y", (d) => (yScale(d.label) ?? 0) + yScale.bandwidth() / 2)
              .attr("dominant-baseline", "middle")
              .attr("text-anchor", (d) => (xScale(d.value) < 20 ? "start" : "end"))
              .attr("font-size", "10px")
              .attr("fill", CHART_TEXT_MUTED)
              .attr("pointer-events", "none")
              .text((d) => applyNumberFormat(d.value, numberFormat));
          }

          bars
            .on("mouseenter", function (event: MouseEvent, d) {
              d3.select(this).attr("opacity", 0.8);
              show(
                event,
                formatTooltip(
                  d.label,
                  d.value,
                  tooltipPrefix,
                  tooltipSuffix,
                  tooltipTemplate,
                ),
              );
              onHover?.(d);
            })
            .on("mouseleave", function () {
              d3.select(this).attr("opacity", 1);
              hide();
              onHover?.(null);
            })
            .on("click", (_, d) => onBarClick?.(d.label));

          // Reference Lines (horizontal bar)
          if (referenceLines && referenceLines.length > 0) {
            const refGroup = g.append("g").attr("class", "reference-lines");
            referenceLines.forEach((ref) => {
              const xVal = xScale(ref.value);
              if (xVal == null || isNaN(xVal)) return;
              refGroup
                .append("line")
                .attr("x1", xVal)
                .attr("x2", xVal)
                .attr("y1", 0)
                .attr("y2", innerHeight)
                .attr("stroke", ref.color ?? CHART_NEGATIVE)
                .attr("stroke-width", 1.5)
                .attr("stroke-dasharray", ref.style === "solid" ? "none" : "4 4");
              if (ref.label) {
                refGroup
                  .append("text")
                  .attr("x", xVal + 2)
                  .attr("y", 10)
                  .attr("text-anchor", "start")
                  .attr("font-size", "10px")
                  .attr("fill", ref.color ?? CHART_NEGATIVE)
                  .text(ref.label);
              }
            });
          }
        }
        return;
      }

      // ------------------------------------------------------------------ //
      // MULTI-SERIES variants: grouped, stacked, stacked-100
      // ------------------------------------------------------------------ //
      if (!seriesData) return;

      // Resolve color per series key
      const seriesColorMap: Record<string, string> = {};
      resolvedSeries.forEach((s, i) => {
        seriesColorMap[s.key] = s.color ?? getColor(i);
      });
      const seriesLabelMap: Record<string, string> = {};
      resolvedSeries.forEach((s) => {
        seriesLabelMap[s.key] = s.label;
      });

      // Build row objects for d3.stack: [{ category, key1: val, key2: val, ... }]
      type RowDatum = Record<string, number | string>;
      const stackInput: RowDatum[] = resolvedCategories.map((cat) => {
        const row: RowDatum = { category: cat };
        seriesKeys.forEach((k) => {
          row[k] = seriesData[cat]?.[k] ?? 0;
        });
        return row;
      });

      if (effectiveVariant === "grouped") {
        // Outer scale: categories
        const xOuter = d3
          .scaleBand()
          .domain(resolvedCategories)
          .range([0, innerWidth])
          .paddingInner(0.2)
          .paddingOuter(0.1);

        // Inner scale: series within a category band
        const xInner = d3
          .scaleBand()
          .domain(seriesKeys)
          .range([0, xOuter.bandwidth()])
          .padding(0.05);

        const maxVal =
          d3.max(stackInput, (row) => d3.max(seriesKeys, (k) => row[k] as number)) ?? 0;

        const yScale = d3
          .scaleLinear()
          .domain([0, maxVal])
          .nice()
          .range([innerHeight, 0]);

        if (showGrid) {
          const gridG = g
            .append("g")
            .call(
              d3
                .axisLeft(yScale)
                .tickSize(-innerWidth)
                .tickFormat(() => ""),
            );
          themeGrid(gridG);
        }

        const xAxisG = g
          .append("g")
          .attr("transform", `translate(0,${innerHeight})`)
          .call(d3.axisBottom(xOuter));
        themeAxis(xAxisG);
        xAxisG.selectAll<SVGTextElement, unknown>("text").style("font-size", `${axisFontSize}px`);
        if (width < 300) {
          xAxisG
            .selectAll<SVGTextElement, unknown>("text")
            .attr("transform", "rotate(-45)")
            .attr("text-anchor", "end")
            .attr("dx", "-0.5em")
            .attr("dy", "0.5em");
        }

        const yAxisG = g
          .append("g")
          .call(d3.axisLeft(yScale).tickFormat((d) => formatNumber(d as number, 0)));
        themeAxis(yAxisG);
        yAxisG.selectAll<SVGTextElement, unknown>("text").style("font-size", `${axisFontSize}px`);

        // One group element per category
        const categoryGroups = g
          .selectAll<SVGGElement, RowDatum>(".category-group")
          .data(stackInput)
          .join("g")
          .attr("class", "category-group")
          .attr(
            "transform",
            (d) => `translate(${xOuter(d.category as string) ?? 0},0)`,
          );

        // One rect per series inside each category group
        seriesKeys.forEach((key) => {
          // H-1: skip hidden series
          if (hiddenSeries.has(key)) return;

          const color = seriesColorMap[key]!;
          const label = seriesLabelMap[key]!;

          const bars = categoryGroups
            .append("rect")
            .attr("class", "bar")
            .style("cursor", "pointer")
            .attr("x", xInner(key) ?? 0)
            .attr("width", xInner.bandwidth())
            .attr("rx", 4)
            .attr("fill", color)
            .attr("y", innerHeight)
            .attr("height", 0);

          if (animDuration > 0) {
            bars
              .transition()
              .duration(animDuration)
              .ease(d3.easeQuadOut)
              .attr("y", (d) => yScale(d[key] as number))
              .attr("height", (d) => innerHeight - yScale(d[key] as number));
          } else {
            bars
              .attr("y", (d) => yScale(d[key] as number))
              .attr("height", (d) => innerHeight - yScale(d[key] as number));
          }

          const effectiveLabelPositionG =
            labelPosition ?? (showLabels ? "outside" : "none");
          if (effectiveLabelPositionG !== "none") {
            categoryGroups
              .append("text")
              .attr("class", "bar-label")
              .attr("x", (xInner(key) ?? 0) + xInner.bandwidth() / 2)
              .attr("y", (d) => {
                if (effectiveLabelPositionG === "inside")
                  return yScale(d[key] as number) + 14;
                return yScale(d[key] as number) - 4;
              })
              .attr("text-anchor", "middle")
              .attr("font-size", "11px")
              .attr("fill", CHART_TEXT_MUTED)
              .text((d) => formatNumber(d[key] as number, 0));
          }

          // M-5: showDataLabels for grouped bar
          if (showDataLabels) {
            categoryGroups
              .append("text")
              .attr("class", `data-label-grouped-${key}`)
              .attr("x", (xInner(key) ?? 0) + xInner.bandwidth() / 2)
              .attr("y", (d) => {
                const barHeight = innerHeight - yScale(d[key] as number);
                if (barHeight < 20) return -9999;
                return yScale(d[key] as number) - 4;
              })
              .attr("text-anchor", "middle")
              .attr("font-size", "10px")
              .attr("fill", CHART_TEXT_MUTED)
              .attr("pointer-events", "none")
              .text((d) => formatNumber(d[key] as number, 0));
          }

          bars
            .on("mouseenter", function (event: MouseEvent, d) {
              d3.select(this).attr("opacity", 0.8);
              const value = d[key] as number;
              show(event, `${d.category} - ${label}: ${formatNumber(value, 0)}`);
            })
            .on("mouseleave", function () {
              d3.select(this).attr("opacity", 1);
              hide();
            });
        });
      } else {
        // stacked or stacked-100
        const offset =
          effectiveVariant === "stacked-100"
            ? d3.stackOffsetExpand
            : d3.stackOffsetNone;

        // M-4: percent mode — normalize each group to 100
        const isPercentMode =
          effectiveVariant === "stacked" && stackMode === "percent";
        const normalizedStackInput: RowDatum[] = isPercentMode
          ? stackInput.map((row) => {
              const groupTotal = seriesKeys.reduce(
                (sum, k) => sum + (row[k] as number),
                0,
              );
              const normalized: RowDatum = { category: row.category! };
              seriesKeys.forEach((k) => {
                normalized[k] =
                  groupTotal > 0 ? ((row[k] as number) / groupTotal) * 100 : 0;
              });
              return normalized;
            })
          : stackInput;

        const stackGen = d3
          .stack<RowDatum>()
          .keys(seriesKeys)
          .offset(offset)
          .value((d, key) => d[key] as number);

        const stackedData = stackGen(normalizedStackInput);

        const xScale = d3
          .scaleBand()
          .domain(resolvedCategories)
          .range([0, innerWidth])
          .padding(0.25);

        // For stacked-100 or percent mode, yDomain is fixed; for stacked, compute from stacked max
        const yMax =
          effectiveVariant === "stacked-100"
            ? 1
            : isPercentMode
              ? 100
              : (d3.max(stackedData, (layer) => d3.max(layer, (seg) => seg[1])) ?? 0);

        const yScale = d3
          .scaleLinear()
          .domain([0, yMax])
          .nice()
          .range([innerHeight, 0]);

        if (showGrid) {
          const gridG = g
            .append("g")
            .call(
              d3
                .axisLeft(yScale)
                .tickSize(-innerWidth)
                .tickFormat(() => ""),
            );
          themeGrid(gridG);
        }

        const xAxisG = g
          .append("g")
          .attr("transform", `translate(0,${innerHeight})`)
          .call(d3.axisBottom(xScale));
        themeAxis(xAxisG);
        xAxisG.selectAll<SVGTextElement, unknown>("text").style("font-size", `${axisFontSize}px`);
        if (width < 300) {
          xAxisG
            .selectAll<SVGTextElement, unknown>("text")
            .attr("transform", "rotate(-45)")
            .attr("text-anchor", "end")
            .attr("dx", "-0.5em")
            .attr("dy", "0.5em");
        }

        const stackedYAxisFormat =
          effectiveVariant === "stacked-100"
            ? (d: d3.NumberValue) => `${Math.round((d as number) * 100)}%`
            : isPercentMode
              ? (d: d3.NumberValue) => `${Math.round(d as number)}%`
              : yTickFormatter;

        const yAxisG = g
          .append("g")
          .call(d3.axisLeft(yScale).tickFormat(stackedYAxisFormat));
        themeAxis(yAxisG);
        yAxisG.selectAll<SVGTextElement, unknown>("text").style("font-size", `${axisFontSize}px`);

        // Render each layer
        stackedData.forEach((layer, layerIndex) => {
          const key = layer.key;
          const color = seriesColorMap[key]!;
          const label = seriesLabelMap[key]!;

          type StackSegment = d3.SeriesPoint<RowDatum>;

          const bars = g
            .selectAll<SVGRectElement, StackSegment>(`.bar-${key}`)
            .data(layer)
            .join("rect")
            .attr("class", `bar-${key}`)
            .style("cursor", "pointer")
            .attr("x", (seg) => xScale((seg.data as RowDatum).category as string) ?? 0)
            .attr("width", xScale.bandwidth())
            .attr("rx", 4)
            .attr("fill", color)
            .attr("y", innerHeight)
            .attr("height", 0);

          if (animDuration > 0) {
            bars
              .transition()
              .duration(animDuration)
              .ease(d3.easeQuadOut)
              .attr("y", (seg) => yScale(seg[1]))
              .attr("height", (seg) => yScale(seg[0]) - yScale(seg[1]));
          } else {
            bars
              .attr("y", (seg) => yScale(seg[1]))
              .attr("height", (seg) => yScale(seg[0]) - yScale(seg[1]));
          }

          const effectiveLabelPositionS =
            labelPosition ?? (showLabels ? "inside" : "none");
          if (effectiveLabelPositionS !== "none") {
            g.selectAll<SVGTextElement, StackSegment>(`.bar-label-${key}`)
              .data(layer)
              .join("text")
              .attr("class", `bar-label-${key}`)
              .attr(
                "x",
                (seg) =>
                  (xScale((seg.data as RowDatum).category as string) ?? 0) +
                  xScale.bandwidth() / 2,
              )
              .attr("y", (seg) => yScale(seg[1]) + (yScale(seg[0]) - yScale(seg[1])) / 2)
              .attr("text-anchor", "middle")
              .attr("dominant-baseline", "middle")
              .attr("font-size", "11px")
              .attr("fill", CHART_TEXT_MUTED)
              .text((seg) => {
                const rawVal = (seg.data as RowDatum)[key] as number;
                if (effectiveVariant === "stacked-100") {
                  return `${Math.round((seg[1] - seg[0]) * 100)}%`;
                }
                if (isPercentMode) {
                  return `${Math.round(seg[1] - seg[0])}%`;
                }
                return formatNumber(rawVal, 0);
              });
          }

          // M-5: showDataLabels — render value label on each bar segment
          if (showDataLabels) {
            // NOTE: layerIndex used to namespace label class per series key
            void layerIndex;
            g.selectAll<SVGTextElement, StackSegment>(`.data-label-${key}`)
              .data(layer)
              .join("text")
              .attr("class", `data-label-${key}`)
              .attr(
                "x",
                (seg) =>
                  (xScale((seg.data as RowDatum).category as string) ?? 0) +
                  xScale.bandwidth() / 2,
              )
              .attr("y", (seg) => yScale(seg[1]) + (yScale(seg[0]) - yScale(seg[1])) / 2)
              .attr("text-anchor", "middle")
              .attr("dominant-baseline", "middle")
              .attr("font-size", "10px")
              .attr("fill", CHART_TEXT_MUTED)
              .attr("pointer-events", "none")
              .text((seg) => {
                const barHeight = yScale(seg[0]) - yScale(seg[1]);
                if (barHeight < 20) return "";
                const rawVal = (seg.data as RowDatum)[key] as number;
                if (effectiveVariant === "stacked-100") {
                  return `${Math.round((seg[1] - seg[0]) * 100)}%`;
                }
                if (isPercentMode) {
                  return `${Math.round(seg[1] - seg[0])}%`;
                }
                return formatNumber(rawVal, 0);
              });
          }

          bars
            .on("mouseenter", function (event: MouseEvent, seg) {
              d3.select(this).attr("opacity", 0.8);
              const cat = (seg.data as RowDatum).category as string;
              const rawVal = (seg.data as RowDatum)[key] as number;
              const displayVal =
                effectiveVariant === "stacked-100"
                  ? `${Math.round((seg[1] - seg[0]) * 100)}%`
                  : isPercentMode
                    ? `${Math.round(seg[1] - seg[0])}%`
                    : formatNumber(rawVal, 0);
              show(event, `${cat} - ${label}: ${displayVal}`);
            })
            .on("mouseleave", function () {
              d3.select(this).attr("opacity", 1);
              hide();
            });
        });
      }
    },
    [
      data,
      seriesData,
      seriesKeys,
      resolvedCategories,
      effectiveVariant,
      width,
      height,
      orientation,
      showGrid,
      animated,
      innerWidth,
      innerHeight,
      colorScheme,
      labelPosition,
      sortOrder,
      limitRows,
      numberFormat,
      referenceLines,
      onBarClick,
      thresholdGood,
      thresholdBad,
      conditionalFormat,
      stackMode,
      showDataLabels,
      hiddenSeries,
      animationDuration,
      showZeroLine,
    ],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full overflow-hidden", className)}
    >
      <svg
        ref={svgRef}
        role="img"
        aria-label={`棒グラフ: ${data ? data.map((d) => `${d.label} ${d.value}`).join(", ") : (series?.map((s) => s.label).join(", ") ?? "")}`}
      />
      {showLegend && resolvedSeries.length > 0 && (
        <div
          className="flex flex-wrap gap-2 pt-2"
          role="list"
          aria-label="Chart legend"
        >
          {resolvedSeries.map((s, i) => {
            const isHidden = hiddenSeries.has(s.key);
            return (
              <div
                key={s.key}
                className="flex cursor-pointer items-center gap-1 text-[11px]"
                role="listitem"
                onClick={() => {
                  setHiddenSeries((prev) => {
                    const next = new Set(prev);
                    if (next.has(s.key)) next.delete(s.key);
                    else next.add(s.key);
                    return next;
                  });
                }}
                style={{ color: CHART_TEXT_MUTED, opacity: isHidden ? 0.4 : 1 }}
                aria-pressed={isHidden}
              >
                <span
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                  style={{ backgroundColor: s.color ?? getColor(i) }}
                  aria-hidden="true"
                />
                <span>{s.label}</span>
              </div>
            );
          })}
        </div>
      )}
      <ChartTooltip
        x={tooltipState.x}
        y={tooltipState.y}
        content={tooltipState.content}
        visible={tooltipState.visible}
      />
    </div>
  );
}
