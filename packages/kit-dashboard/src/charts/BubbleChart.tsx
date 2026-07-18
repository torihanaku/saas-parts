import * as d3 from "d3";
import { useMemo, useRef } from "react";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { PRIMARY } from "../lib/chartRoles";
import { formatNumber } from "../lib/formatters";
import { themeAxis, themeGrid } from "../lib/d3Theme";
import { CHART_TEXT_MUTED, CHART_SURFACE } from "../lib/theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface BubblePoint {
  x: number;
  y: number;
  size: number;
  label: string;
  color?: string;
}

export interface BubbleChartProps {
  data: BubblePoint[];
  xLabel?: string;
  yLabel?: string;
  maxBubbleRadius?: number;
  width?: number;
  height?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  className?: string;
}

const DEFAULT_MARGIN = { top: 20, right: 20, bottom: 40, left: 50 };

export function BubbleChart({
  data,
  xLabel,
  yLabel,
  maxBubbleRadius = 40,
  width: propWidth,
  height = 320,
  margin = DEFAULT_MARGIN,
  className,
}: BubbleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { show, hide, tooltipRef } = useTooltip();

  const width = propWidth ?? observedWidth;
  const svgHeight = height;
  // useMemo で安定化（毎レンダー新規オブジェクトを useD3 deps に載せない）。
  const mg = useMemo(
    () => margin ?? DEFAULT_MARGIN,
    [margin],
  );

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (width === 0 || data.length === 0) return;

      const innerWidth = width - mg.left - mg.right;
      const innerHeight = svgHeight - mg.top - mg.bottom;

      if (innerWidth <= 0 || innerHeight <= 0) return;

      const maxX = d3.max(data, (d) => d.x) ?? 1;
      const maxY = d3.max(data, (d) => d.y) ?? 1;
      const maxSize = d3.max(data, (d) => d.size) ?? 1;

      const xScale = d3
        .scaleLinear()
        .domain([0, maxX * 1.1])
        .range([0, innerWidth])
        .nice();

      const yScale = d3
        .scaleLinear()
        .domain([0, maxY * 1.1])
        .range([innerHeight, 0])
        .nice();

      const sizeScale = d3
        .scaleLinear()
        .domain([0, maxSize])
        .range([4, maxBubbleRadius]);

      svg.attr("width", width).attr("height", svgHeight);

      const g = svg
        .append("g")
        .attr("transform", `translate(${mg.left},${mg.top})`);

      // グリッド線（X）— 軸/グリッドはテーマトークンで統一（生 stroke を書かない）。
      const gridXG = g
        .append("g")
        .attr("class", "grid-x")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(
          d3
            .axisBottom(xScale)
            .tickSize(-innerHeight)
            .tickFormat(() => ""),
        );
      themeGrid(gridXG);

      // グリッド線（Y）
      const gridYG = g
        .append("g")
        .attr("class", "grid-y")
        .call(
          d3
            .axisLeft(yScale)
            .tickSize(-innerWidth)
            .tickFormat(() => ""),
        );
      themeGrid(gridYG);

      // X軸
      const xAxisG = g
        .append("g")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(d3.axisBottom(xScale).ticks(5));
      themeAxis(xAxisG);

      // Y軸
      const yAxisG = g.append("g").call(d3.axisLeft(yScale).ticks(5));
      themeAxis(yAxisG);

      // X軸ラベル
      if (xLabel) {
        g.append("text")
          .attr("x", innerWidth / 2)
          .attr("y", innerHeight + mg.bottom - 4)
          .attr("text-anchor", "middle")
          .style("font-size", "12px")
          .style("fill", CHART_TEXT_MUTED)
          .text(xLabel);
      }

      // Y軸ラベル
      if (yLabel) {
        g.append("text")
          .attr("transform", "rotate(-90)")
          .attr("x", -innerHeight / 2)
          .attr("y", -mg.left + 14)
          .attr("text-anchor", "middle")
          .style("font-size", "12px")
          .style("fill", CHART_TEXT_MUTED)
          .text(yLabel);
      }

      // バブル描画
      g.selectAll<SVGCircleElement, BubblePoint>("circle")
        .data(data)
        .join("circle")
        .attr("class", "bubble")
        .style("cursor", "pointer")
        .attr("cx", (d) => xScale(d.x))
        .attr("cy", (d) => yScale(d.y))
        .attr("r", 0)
        // 単一系列の点は虹色にせず PRIMARY 単色。差はサイズ（size）で表現する。
        .attr("fill", (d) => d.color ?? PRIMARY())
        .attr("fill-opacity", 0.7)
        .attr("stroke", CHART_SURFACE)
        .attr("stroke-width", 1.5)
        .on("mouseover", function (event: MouseEvent, d) {
          d3.select(this).attr("fill-opacity", 1).attr("stroke-width", 2.5);
          const content = `${d.label}\nX: ${formatNumber(d.x)}  Y: ${formatNumber(d.y)}`;
          show(event, content);
        })
        .on("mousemove", function (event: MouseEvent, d) {
          const content = `${d.label}\nX: ${formatNumber(d.x)}  Y: ${formatNumber(d.y)}`;
          show(event, content);
        })
        .on("mouseout", function () {
          d3.select(this).attr("fill-opacity", 0.7).attr("stroke-width", 1.5);
          hide();
        })
        .transition()
        .duration(600)
        .ease(d3.easeCubicOut)
        .attr("r", (d) => sizeScale(d.size));
    },
    [data, width, svgHeight, maxBubbleRadius, xLabel, yLabel, mg],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full overflow-hidden", className)}
    >
      <svg ref={svgRef} className="block w-full" />
      <ChartTooltip ref={tooltipRef} />
    </div>
  );
}
