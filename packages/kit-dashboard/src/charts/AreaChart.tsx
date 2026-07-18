import { useRef } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { DEFAULT_MARGIN, getInnerDimensions } from "../lib/d3Helpers";
import { getChartColor, getColorScheme } from "../lib/colorUtils";
import { formatNumber, formatDateShort } from "../lib/formatters";
import { CHART_TEXT_MUTED, CHART_NEGATIVE } from "../lib/theme";
import { themeAxis, themeGrid } from "../lib/d3Theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";
import type { AreaChartProps, TimeSeriesPoint } from "../lib/types";

// Mock multi-series labels for stacked/100pct demo
const STACKED_SERIES = ["オーガニック", "有料広告", "SNS", "メール"];
const STACKED_SERIES_BASES = [500, 300, 200, 150];

function buildStackedMockData(base: TimeSeriesPoint[]): TimeSeriesPoint[] {
  const result: TimeSeriesPoint[] = [];
  base.forEach((d) => {
    STACKED_SERIES.forEach((name, si) => {
      const baseVal = STACKED_SERIES_BASES[si] ?? 100;
      result.push({
        date: d.date,
        value: Math.round(
          baseVal + Math.sin(d.date.getTime() / 1e10 + si * 2) * baseVal * 0.3,
        ),
        series: name,
      });
    });
  });
  return result;
}

// ゼロ設定でも描画できる既定データ（他チャートと同様）
const DEFAULT_AREA_DATA: TimeSeriesPoint[] = [
  { date: new Date(2026, 0, 1), value: 120 },
  { date: new Date(2026, 1, 1), value: 180 },
  { date: new Date(2026, 2, 1), value: 150 },
  { date: new Date(2026, 3, 1), value: 240 },
  { date: new Date(2026, 4, 1), value: 210 },
  { date: new Date(2026, 5, 1), value: 300 },
];

export function AreaChart({
  data = DEFAULT_AREA_DATA,
  series,
  width: propWidth,
  height = 300,
  margin = DEFAULT_MARGIN,
  smooth = false,
  showDots = false,
  showGrid = true,
  animated = true,
  fillOpacity: fillOpacityProp,
  colors: colorsProp,
  colorScheme,
  customColor,
  fillGradient = false,
  className,
  variant = "standard",
  referenceLines,
  showTrendline,
  yAxisMin,
  yAxisMax,
  animationDuration,
}: AreaChartProps & {
  colorScheme?: string;
  customColor?: string;
  fillGradient?: boolean;
  showTrendline?: boolean;
  animationDuration?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { state: tooltipState, show, hide } = useTooltip();

  const width = propWidth ?? observedWidth;
  const { innerWidth, innerHeight } = getInnerDimensions(width, height, margin);

  // Opacity: 0.7 for standard, 0.6 for stacked variants, unless explicitly provided
  const fillOpacity = fillOpacityProp ?? (variant === "standard" ? 0.7 : 0.6);

  // Inject mock stacked data when variant is stacked/100pct and data is single-series
  const effectiveData: typeof data = (() => {
    if (variant !== "stacked" && variant !== "100pct") return data;
    const keys = Array.from(new Set(data.map((d) => d.series ?? "default")));
    if (keys.length <= 1) return buildStackedMockData(data);
    return data;
  })();

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (!effectiveData.length || innerWidth <= 0 || innerHeight <= 0) return;

      svg.attr("width", width).attr("height", height);

      const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      // colorScheme override
      const schemeColors = colorScheme
        ? getColorScheme(colorScheme, customColor)
        : null;
      const resolveColor = (index: number, perItemColor?: string) =>
        perItemColor ??
        schemeColors?.[index % schemeColors.length] ??
        colorsProp?.[index] ??
        getChartColor(index);

      // gradient defs (used when fillGradient=true)
      const defsEl = svg.append("defs");

      // series 別グループ化
      const grouped = d3.group(effectiveData, (d) => d.series ?? "default");
      const seriesKeys = series ?? Array.from(grouped.keys());

      // スケール
      const allDates = effectiveData.map((d) => d.date);
      const uniqueDates = Array.from(
        new Set(allDates.map((d) => d.getTime())),
      )
        .map((t) => new Date(t))
        .sort((a, b) => a.getTime() - b.getTime());

      const xScale = d3
        .scaleTime()
        .domain([d3.min(allDates) ?? new Date(), d3.max(allDates) ?? new Date()])
        .range([0, innerWidth]);

      // Resolve animation duration: 0 = disabled, undefined = default 600ms
      const animDuration = animationDuration !== undefined ? animationDuration : 600;

      // curve 設定
      const curveType = smooth ? d3.curveCatmullRom.alpha(0.5) : d3.curveLinear;

      if (variant === "stacked" || variant === "100pct") {
        // Build wide-format data: [{ date, series1: val, series2: val, ... }]
        type WideRow = Record<string, number | Date>;
        const wideData: WideRow[] = uniqueDates.map((date) => {
          const row: WideRow = { date };
          seriesKeys.forEach((key) => {
            const pts = grouped.get(key) ?? [];
            const match = pts.find((p) => p.date.getTime() === date.getTime());
            row[key] = match?.value ?? 0;
          });
          return row;
        });

        // d3.stack
        const stack = d3
          .stack<WideRow, string>()
          .keys(seriesKeys)
          .value((d, key) => (d[key] as number) ?? 0);

        if (variant === "100pct") {
          stack.offset(d3.stackOffsetExpand);
        }

        const stackedSeries = stack(wideData);

        // Y scale
        const yMax =
          variant === "100pct"
            ? 1
            : d3.max(stackedSeries, (s) => d3.max(s, (d) => d[1])) ?? 0;

        const yScale = d3
          .scaleLinear()
          .domain([0, variant === "100pct" ? 1 : yMax * 1.1])
          .nice()
          .range([innerHeight, 0]);

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

        // X軸
        const xAxisG = g
          .append("g")
          .attr("transform", `translate(0,${innerHeight})`)
          .call(
            d3.axisBottom(xScale).tickFormat((d) => formatDateShort(d as Date)),
          );
        themeAxis(xAxisG);

        // Y軸
        const yAxisG = g.append("g").call(
          d3.axisLeft(yScale).tickFormat((d) =>
            variant === "100pct"
              ? `${Math.round((d as number) * 100)}%`
              : formatNumber(d as number, 0),
          ),
        );
        themeAxis(yAxisG);

        // Stacked area + line generators
        type StackDatum = d3.SeriesPoint<WideRow>;

        const areaGen = d3
          .area<StackDatum>()
          .x((d) => xScale((d.data as WideRow).date as Date))
          .y0((d) => yScale(d[0]))
          .y1((d) => yScale(d[1]))
          .curve(curveType);

        const lineGen = d3
          .line<StackDatum>()
          .x((d) => xScale((d.data as WideRow).date as Date))
          .y((d) => yScale(d[1]))
          .curve(curveType);

        stackedSeries.forEach((s, i) => {
          const color = resolveColor(i);

          // gradient def for this series
          if (fillGradient) {
            const grad = defsEl
              .append("linearGradient")
              .attr("id", `area-grad-stacked-${i}`)
              .attr("x1", "0")
              .attr("y1", "0")
              .attr("x2", "0")
              .attr("y2", "1");
            grad
              .append("stop")
              .attr("offset", "0%")
              .attr("stop-color", color)
              .attr("stop-opacity", fillOpacity * 4);
            grad
              .append("stop")
              .attr("offset", "100%")
              .attr("stop-color", color)
              .attr("stop-opacity", 0);
          }

          // エリア
          g.append("path")
            .datum(s)
            .attr("fill", fillGradient ? `url(#area-grad-stacked-${i})` : color)
            .attr("fill-opacity", fillGradient ? 1 : fillOpacity)
            .attr("d", areaGen);

          // ライン
          const path = g
            .append("path")
            .datum(s)
            .attr("fill", "none")
            .attr("stroke", color)
            .attr("stroke-width", 2)
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
              .attr(
                "stroke-dasharray",
                ref.style === "solid" ? "none" : "4 4",
              );
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

        // 透明オーバーレイ
        g.append("rect")
          .attr("width", innerWidth)
          .attr("height", innerHeight)
          .attr("fill", "transparent")
          .on("mousemove", function (event: MouseEvent) {
            const [mx] = d3.pointer(event);
            const hoverDate = xScale.invert(mx);
            let closest: TimeSeriesPoint | null = null;
            let minDist = Infinity;
            effectiveData.forEach((d) => {
              const dist = Math.abs(d.date.getTime() - hoverDate.getTime());
              if (dist < minDist) {
                minDist = dist;
                closest = d;
              }
            });
            if (closest) {
              const c = closest as TimeSeriesPoint;
              const seriesLabel =
                c.series && c.series !== "default" ? `${c.series}: ` : "";
              show(
                event,
                `${seriesLabel}${formatNumber(c.value, 0)} (${formatDateShort(c.date)})`,
              );
            }
          })
          .on("mouseleave", () => hide());

        // 凡例
        if (seriesKeys.length > 1 && seriesKeys[0] !== "default") {
          const legend = svg
            .append("g")
            .attr(
              "transform",
              `translate(${margin.left}, ${height - margin.bottom + 30})`,
            );

          seriesKeys.forEach((key, i) => {
            const color = resolveColor(i);
            const item = legend
              .append("g")
              .attr("transform", `translate(${i * 100}, 0)`);

            item
              .append("rect")
              .attr("width", 10)
              .attr("height", 10)
              .attr("fill", color)
              .attr("rx", 2);

            item
              .append("text")
              .attr("x", 14)
              .attr("y", 9)
              .attr("font-size", "11px")
              .attr("fill", CHART_TEXT_MUTED)
              .text(key);
          });
        }
      } else {
        // Standard variant: existing behavior
        const maxVal = d3.max(effectiveData, (d) => d.value) ?? 0;
        const yScale = d3
          .scaleLinear()
          .domain([yAxisMin ?? 0, yAxisMax ?? maxVal * 1.1])
          .nice()
          .range([innerHeight, 0]);

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

        // X軸
        const xAxisG = g
          .append("g")
          .attr("transform", `translate(0,${innerHeight})`)
          .call(
            d3.axisBottom(xScale).tickFormat((d) => formatDateShort(d as Date)),
          );
        themeAxis(xAxisG);

        // Y軸
        const yAxisG = g
          .append("g")
          .call(d3.axisLeft(yScale).tickFormat((d) => formatNumber(d as number, 0)));
        themeAxis(yAxisG);

        // area / line generator
        const areaGen = d3
          .area<TimeSeriesPoint>()
          .x((d) => xScale(d.date))
          .y0(innerHeight)
          .y1((d) => yScale(d.value))
          .curve(curveType);

        const lineGen = d3
          .line<TimeSeriesPoint>()
          .x((d) => xScale(d.date))
          .y((d) => yScale(d.value))
          .curve(curveType);

        // 各系列を描画（エリア → ライン の順）
        seriesKeys.forEach((key, i) => {
          const seriesData = grouped.get(key) ?? [];
          const color = resolveColor(i);

          // gradient def for this series
          if (fillGradient) {
            const grad = defsEl
              .append("linearGradient")
              .attr("id", `area-grad-${i}`)
              .attr("x1", "0")
              .attr("y1", "0")
              .attr("x2", "0")
              .attr("y2", "1");
            grad
              .append("stop")
              .attr("offset", "0%")
              .attr("stop-color", color)
              .attr("stop-opacity", fillOpacity * 4);
            grad
              .append("stop")
              .attr("offset", "100%")
              .attr("stop-color", color)
              .attr("stop-opacity", 0);
          }

          // エリア
          g.append("path")
            .datum(seriesData)
            .attr("fill", fillGradient ? `url(#area-grad-${i})` : color)
            .attr("fill-opacity", fillGradient ? 1 : fillOpacity)
            .attr("d", areaGen);

          // ライン
          const path = g
            .append("path")
            .datum(seriesData)
            .attr("fill", "none")
            .attr("stroke", color)
            .attr("stroke-width", 2)
            .attr("d", lineGen);

          // ライン描画アニメーション
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

          // ドット
          if (showDots) {
            g.selectAll(`.dot-area-${i}`)
              .data(seriesData)
              .join("circle")
              .attr("class", `dot-area-${i}`)
              .attr("cx", (d) => xScale(d.date))
              .attr("cy", (d) => yScale(d.value))
              .attr("r", 3)
              .attr("fill", color)
              .attr("stroke", "white")
              .attr("stroke-width", 1.5)
              .on(
                "mouseenter",
                function (event: MouseEvent, d: TimeSeriesPoint) {
                  d3.select(this).attr("r", 5);
                  const seriesLabel = key !== "default" ? `${key}: ` : "";
                  show(
                    event,
                    `${seriesLabel}${formatNumber(d.value, 0)} (${formatDateShort(d.date)})`,
                  );
                },
              )
              .on("mouseleave", function () {
                d3.select(this).attr("r", 3);
                hide();
              });
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
              .attr(
                "stroke-dasharray",
                ref.style === "solid" ? "none" : "4 4",
              );
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

        // Trendline (linear regression) for standard variant
        if (showTrendline && effectiveData.length >= 2) {
          const yVals = effectiveData.map((d) => d.value);
          const n = effectiveData.length;
          const sumX = (n * (n - 1)) / 2;
          const sumY = yVals.reduce((a, b) => a + b, 0);
          const sumXY = yVals.reduce((s, y, i) => s + i * y, 0);
          const sumXX = (n * (n - 1) * (2 * n - 1)) / 6;
          const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
          const intercept = (sumY - slope * sumX) / n;
          g.append("line")
            .attr("x1", xScale(effectiveData[0]!.date))
            .attr("x2", xScale(effectiveData[n - 1]!.date))
            .attr("y1", yScale(intercept))
            .attr("y2", yScale(slope * (n - 1) + intercept))
            .attr("stroke", CHART_NEGATIVE)
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", "6 3")
            .attr("opacity", 0.75)
            .attr("pointer-events", "none");
        }

        // 透明オーバーレイ：マウス位置トラッキング
        g.append("rect")
          .attr("width", innerWidth)
          .attr("height", innerHeight)
          .attr("fill", "transparent")
          .on("mousemove", function (event: MouseEvent) {
            const [mx] = d3.pointer(event);
            const hoverDate = xScale.invert(mx);
            let closest: TimeSeriesPoint | null = null;
            let minDist = Infinity;
            effectiveData.forEach((d) => {
              const dist = Math.abs(d.date.getTime() - hoverDate.getTime());
              if (dist < minDist) {
                minDist = dist;
                closest = d;
              }
            });
            if (closest) {
              const c = closest as TimeSeriesPoint;
              const seriesLabel =
                c.series && c.series !== "default" ? `${c.series}: ` : "";
              show(
                event,
                `${seriesLabel}${formatNumber(c.value, 0)} (${formatDateShort(c.date)})`,
              );
            }
          })
          .on("mouseleave", () => hide());
      }
    },
    [
      effectiveData,
      data,
      width,
      height,
      smooth,
      showDots,
      showGrid,
      animated,
      fillOpacity,
      innerWidth,
      innerHeight,
      variant,
      colorScheme,
      fillGradient,
      referenceLines,
      showTrendline,
      yAxisMin,
      yAxisMax,
      animationDuration,
    ],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
    >
      <svg ref={svgRef} />
      <ChartTooltip
        x={tooltipState.x}
        y={tooltipState.y}
        content={tooltipState.content}
        visible={tooltipState.visible}
      />
    </div>
  );
}
