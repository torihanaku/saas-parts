import { useRef } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { DEFAULT_MARGIN, getInnerDimensions } from "../lib/d3Helpers";
import { getColorScheme } from "../lib/colorUtils";
import { PRIMARY, categoricalColor } from "../lib/chartRoles";
import { CHART_TEXT_MUTED } from "../lib/theme";
import { themeAxis, themeGrid } from "../lib/d3Theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface ScatterPoint {
  x: number;
  y: number;
  label?: string;
  series?: string;
}

export interface ScatterChartProps {
  data?: ScatterPoint[];
  xLabel?: string;
  yLabel?: string;
  width?: number;
  height?: number;
  colorScheme?: "blue" | "green" | "orange" | "purple" | "red";
  showTrendline?: boolean;
  dotSize?: number;
  animated?: boolean;
  className?: string;
}

// 多系列 = 真のカテゴリ → categoricalColor で --chart-1.. に循環マッピング
const SERIES_COLORS = [0, 1, 2, 3, 4].map((i) => categoricalColor(i));

const DEFAULT_DATA: ScatterPoint[] = [
  { x: 120, y: 85, label: "エンタープライズ", series: "A" },
  { x: 80, y: 60, label: "中堅企業", series: "A" },
  { x: 45, y: 40, label: "SMB", series: "B" },
  { x: 20, y: 25, label: "スタートアップ", series: "B" },
  { x: 150, y: 30, label: "官公庁", series: "A" },
  { x: 60, y: 72, label: "医療", series: "B" },
  { x: 95, y: 55, label: "製造", series: "A" },
  { x: 35, y: 48, label: "小売", series: "B" },
  { x: 110, y: 90, label: "金融", series: "A" },
  { x: 70, y: 35, label: "教育", series: "B" },
];

function leastSquaresRegression(
  points: ScatterPoint[],
): { slope: number; intercept: number } {
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0 };

  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

export function ScatterChart({
  data,
  xLabel,
  yLabel,
  width: propWidth,
  height = 300,
  colorScheme = "blue",
  showTrendline = false,
  dotSize,
  animated = true,
  className,
}: ScatterChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { state: tooltipState, show, hide } = useTooltip();

  const margin = DEFAULT_MARGIN;
  const width = propWidth ?? observedWidth;
  const resolvedData = data ?? DEFAULT_DATA;
  const { innerWidth, innerHeight } = getInnerDimensions(width, height, margin);
  const radius = dotSize ?? 5;

  // Determine series keys for color mapping
  const seriesKeys = Array.from(
    new Set(resolvedData.map((d) => d.series).filter(Boolean)),
  ) as string[];
  const hasSeries = seriesKeys.length > 0;
  const seriesColorScale = d3
    .scaleOrdinal<string>()
    .domain(seriesKeys)
    .range(SERIES_COLORS);
  // 単一系列の点 = PRIMARY(chart-1)。既定("blue")は主系列色に寄せ、
  // 明示的な配色スキーム(green/orange/…)を選んだ時だけそのスキーム色を使う。
  const singleColor =
    colorScheme && colorScheme !== "blue"
      ? getColorScheme(colorScheme)[0]!
      : PRIMARY();

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (innerWidth <= 0 || innerHeight <= 0 || resolvedData.length === 0)
        return;

      svg.attr("width", width).attr("height", height);

      // Clip path to keep dots inside plot area
      const clipId = "scatter-clip";
      svg
        .append("defs")
        .append("clipPath")
        .attr("id", clipId)
        .append("rect")
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", innerWidth)
        .attr("height", innerHeight);

      const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      // Scales
      const xExtent = d3.extent(resolvedData, (d) => d.x) as [number, number];
      const yExtent = d3.extent(resolvedData, (d) => d.y) as [number, number];

      const xScale = d3
        .scaleLinear()
        .domain([xExtent[0] * 0.9, xExtent[1] * 1.1])
        .nice()
        .range([0, innerWidth]);

      const yScale = d3
        .scaleLinear()
        .domain([yExtent[0] * 0.9, yExtent[1] * 1.1])
        .nice()
        .range([innerHeight, 0]);

      // Y grid lines
      const yGridG = g
        .append("g")
        .call(
          d3
            .axisLeft(yScale)
            .tickSize(-innerWidth)
            .tickFormat(() => ""),
        );
      themeGrid(yGridG);

      // X grid lines
      const xGridG = g
        .append("g")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(
          d3
            .axisBottom(xScale)
            .tickSize(-innerHeight)
            .tickFormat(() => ""),
        );
      themeGrid(xGridG);

      // X axis
      const xAxisG = g
        .append("g")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(d3.axisBottom(xScale).ticks(5));
      themeAxis(xAxisG);

      // Y axis
      const yAxisG = g.append("g").call(d3.axisLeft(yScale).ticks(5));
      themeAxis(yAxisG);

      // X axis label
      if (xLabel) {
        g.append("text")
          .attr("x", innerWidth / 2)
          .attr("y", innerHeight + margin.bottom - 4)
          .attr("text-anchor", "middle")
          .attr("font-size", "11px")
          .attr("fill", CHART_TEXT_MUTED)
          .text(xLabel);
      }

      // Y axis label
      if (yLabel) {
        g.append("text")
          .attr("transform", "rotate(-90)")
          .attr("x", -innerHeight / 2)
          .attr("y", -margin.left + 14)
          .attr("text-anchor", "middle")
          .attr("font-size", "11px")
          .attr("fill", CHART_TEXT_MUTED)
          .text(yLabel);
      }

      // Trendline
      if (showTrendline && resolvedData.length >= 2) {
        const { slope, intercept } = leastSquaresRegression(resolvedData);
        const xDomain = xScale.domain();
        const x1 = xDomain[0]!;
        const x2 = xDomain[1]!;
        const y1 = slope * x1 + intercept;
        const y2 = slope * x2 + intercept;

        g.append("line")
          .style("pointer-events", "none")
          .attr("clip-path", `url(#${clipId})`)
          .attr("stroke", CHART_TEXT_MUTED)
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "5 4")
          .attr("opacity", 0.7)
          .attr("x1", xScale(x1))
          .attr("y1", yScale(y1))
          .attr("x2", xScale(x2))
          .attr("y2", yScale(y2));

        // R² calculation
        const n = resolvedData.length;
        const sumY = resolvedData.reduce((s, p) => s + p.y, 0);
        const yMean = sumY / n;
        const ssTot = resolvedData.reduce(
          (s, p) => s + Math.pow(p.y - yMean, 2),
          0,
        );
        const ssRes = resolvedData.reduce(
          (s, p) => s + Math.pow(p.y - (slope * p.x + intercept), 2),
          0,
        );
        const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

        const interceptStr =
          intercept >= 0
            ? `+ ${intercept.toFixed(2)}`
            : `- ${Math.abs(intercept).toFixed(2)}`;

        // Display equation and R² in top-right of plot area
        g.append("text")
          .attr("x", innerWidth - 4)
          .attr("y", 16)
          .attr("text-anchor", "end")
          .attr("font-size", "11px")
          .attr("fill", CHART_TEXT_MUTED)
          .text(`y = ${slope.toFixed(2)}x ${interceptStr}   R² = ${r2.toFixed(3)}`);
      }

      // Dots group with clip path
      const dotsGroup = g.append("g").attr("clip-path", `url(#${clipId})`);

      const dots = dotsGroup
        .selectAll<SVGCircleElement, ScatterPoint>(".scatter-dot")
        .data(resolvedData)
        .join("circle")
        .attr("class", "scatter-dot")
        .style("cursor", "pointer")
        .attr("cx", (d) => xScale(d.x))
        .attr("cy", (d) => (animated ? innerHeight : yScale(d.y)))
        .attr("r", radius)
        .attr("fill", (d) =>
          hasSeries && d.series ? seriesColorScale(d.series) : singleColor,
        )
        .attr("opacity", animated ? 0 : 0.85);

      if (animated) {
        dots
          .transition()
          .duration(500)
          .ease(d3.easeCubicOut)
          .delay((_, i) => i * 40)
          .attr("cy", (d) => yScale(d.y))
          .attr("opacity", 0.85);
      }

      dots
        .on("mouseenter", function (event: MouseEvent, d) {
          d3.select(this)
            .raise()
            .transition()
            .duration(100)
            .attr("r", radius * 1.5)
            .attr("opacity", 1);

          const parts: string[] = [];
          if (d.label) parts.push(d.label);
          parts.push(`X: ${d.x}`);
          parts.push(`Y: ${d.y}`);
          if (d.series) parts.push(`シリーズ: ${d.series}`);
          show(event, parts.join(" | "));
        })
        .on("mouseleave", function () {
          d3.select(this)
            .transition()
            .duration(100)
            .attr("r", radius)
            .attr("opacity", 0.85);
          hide();
        });
    },
    [
      resolvedData,
      width,
      height,
      innerWidth,
      innerHeight,
      margin,
      colorScheme,
      showTrendline,
      dotSize,
      animated,
      xLabel,
      yLabel,
      radius,
      hasSeries,
      singleColor,
    ],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full overflow-hidden", className)}
      role="img"
      aria-label="散布図チャート"
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
