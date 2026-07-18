import { useRef } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { DEFAULT_MARGIN, getInnerDimensions } from "../lib/d3Helpers";
import { formatNumber, formatCompact } from "../lib/formatters";
import { PRIMARY, sequentialStep } from "../lib/chartRoles";
import { CHART_TEXT_MUTED, CHART_NEGATIVE, CHART_WARNING } from "../lib/theme";
import { themeAxis, themeGrid, tintGradient } from "../lib/d3Theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface HistogramChartProps {
  data?: number[];
  thresholds?: number;
  cumulative?: boolean;
  showGrid?: boolean;
  animated?: boolean;
  showKde?: boolean;
  showMeanLine?: boolean;
  width?: number;
  height?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  className?: string;
}

// Default: 100 random deal sizes between 10,000 and 500,000
function generateDefaultData(): number[] {
  const result: number[] = [];
  for (let i = 0; i < 100; i++) {
    result.push(Math.round(10000 + Math.random() * 490000));
  }
  return result;
}

// Epanechnikov kernel for KDE
function kernelEpanechnikov(bandwidth: number) {
  return function (v: number): number {
    const u = v / bandwidth;
    return Math.abs(u) <= 1 ? (0.75 * (1 - u * u)) / bandwidth : 0;
  };
}

function kernelDensityEstimator(kernel: (v: number) => number, X: number[]) {
  return function (V: number[]): [number, number][] {
    return X.map((x) => [x, d3.mean(V, (v) => kernel(x - v)) ?? 0]);
  };
}

export function HistogramChart({
  data,
  thresholds = 10,
  cumulative = false,
  showGrid = true,
  animated = true,
  showKde = true,
  showMeanLine = true,
  width: propWidth,
  height = 300,
  margin = DEFAULT_MARGIN,
  className,
}: HistogramChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { state: tooltipState, show, hide } = useTooltip();

  const width = propWidth ?? observedWidth;
  const resolvedData = data ?? generateDefaultData();
  const { innerWidth, innerHeight } = getInnerDimensions(width, height, margin);

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (innerWidth <= 0 || innerHeight <= 0 || resolvedData.length === 0) return;

      svg.attr("width", width).attr("height", height);

      const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      const xExtent = d3.extent(resolvedData) as [number, number];

      const xScale = d3.scaleLinear().domain(xExtent).nice().range([0, innerWidth]);

      // Build bins
      const binGenerator = d3
        .bin()
        .domain(xScale.domain() as [number, number])
        .thresholds(xScale.ticks(thresholds));

      const bins = binGenerator(resolvedData);

      // Counts or cumulative counts
      const counts: number[] = [];
      if (cumulative) {
        let running = 0;
        for (const bin of bins) {
          running += bin.length;
          counts.push(running);
        }
      } else {
        for (const bin of bins) {
          counts.push(bin.length);
        }
      }

      const yMax = cumulative ? resolvedData.length : (d3.max(counts) ?? 0);

      const yScale = d3.scaleLinear().domain([0, yMax]).nice().range([innerHeight, 0]);

      // Grid lines
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

      // X axis
      const xAxisG = g
        .append("g")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(
          d3
            .axisBottom(xScale)
            .ticks(5)
            .tickFormat((d) => formatCompact(d as number)),
        );
      themeAxis(xAxisG);

      // Y axis
      const yAxisG = g
        .append("g")
        .call(d3.axisLeft(yScale).tickFormat((d) => formatNumber(d as number, 0)));
      themeAxis(yAxisG);

      // Bars — 単一分布なので虹色にせず単一 hue（PRIMARY）で統一。
      // 深みは縦 tint グラデで出し（ベタ塗り回避）、値の大小は sequentialStep の
      // 不透明度ランプで差別化する（count 降順に濃→淡）。
      const barData = bins.map((bin, i) => ({ bin, count: counts[i]! }));

      // count 降順の順位でランプ index を決める（高い bin ほど濃く）。
      const rankByLabel = new Map<number, number>();
      barData
        .map((d, i) => ({ i, count: d.count }))
        .sort((a, b) => b.count - a.count)
        .forEach((o, rank) => rankByLabel.set(o.i, rank));

      const barTint = tintGradient(svg.append("defs"), PRIMARY(), { dir: "v" });

      const bars = g
        .selectAll<SVGRectElement, (typeof barData)[number]>(".hist-bar")
        .data(barData)
        .join("rect")
        .attr("class", "hist-bar")
        .style("cursor", "pointer")
        .attr("x", (d) => xScale(d.bin.x0 ?? 0) + 1)
        .attr("width", (d) =>
          Math.max(0, xScale(d.bin.x1 ?? 0) - xScale(d.bin.x0 ?? 0) - 2),
        )
        .attr("rx", 2)
        .attr("fill", barTint)
        .attr("fill-opacity", (_d, i) =>
          sequentialStep(rankByLabel.get(i) ?? i, barData.length).opacity,
        )
        .attr("y", innerHeight)
        .attr("height", 0);

      if (animated) {
        bars
          .transition()
          .duration(600)
          .ease(d3.easeCubicOut)
          .delay((_, i) => i * 20)
          .attr("y", (d) => yScale(d.count))
          .attr("height", (d) => innerHeight - yScale(d.count));
      } else {
        bars
          .attr("y", (d) => yScale(d.count))
          .attr("height", (d) => innerHeight - yScale(d.count));
      }

      bars
        .on("mouseenter", function (event: MouseEvent, d) {
          d3.select(this).attr("opacity", 0.8);
          const x0 = formatCompact(d.bin.x0 ?? 0);
          const x1 = formatCompact(d.bin.x1 ?? 0);
          const label = cumulative
            ? `累計: ${formatNumber(d.count, 0)} 件 (${x0}〜${x1})`
            : `${x0}〜${x1}: ${formatNumber(d.count, 0)} 件`;
          show(event, label);
        })
        .on("mouseleave", function () {
          d3.select(this).attr("opacity", 1);
          hide();
        });

      // Count labels above bars
      if (!cumulative) {
        g.selectAll<SVGTextElement, (typeof barData)[number]>(".hist-label")
          .data(barData.filter((d) => d.count > 0))
          .join("text")
          .attr("class", "hist-label")
          .attr(
            "x",
            (d) =>
              xScale(d.bin.x0 ?? 0) +
              (xScale(d.bin.x1 ?? 0) - xScale(d.bin.x0 ?? 0)) / 2,
          )
          .attr("y", (d) => yScale(d.count) - 4)
          .attr("text-anchor", "middle")
          .attr("font-size", 10)
          .attr("fill", CHART_TEXT_MUTED)
          .text((d) => d.count);
      }

      // Mean and Median lines
      if (showMeanLine && !cumulative) {
        const mean = d3.mean(resolvedData) ?? 0;
        const median = d3.median(resolvedData) ?? 0;

        // Mean line
        const meanX = xScale(mean);
        g.append("line")
          .attr("x1", meanX)
          .attr("x2", meanX)
          .attr("y1", 0)
          .attr("y2", innerHeight)
          .attr("stroke", CHART_NEGATIVE)
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "4,3");

        g.append("text")
          .attr("x", meanX + 4)
          .attr("y", 14)
          .attr("font-size", 10)
          .attr("fill", CHART_NEGATIVE)
          .text(`平均 ${formatCompact(mean)}`);

        // Median line (only if meaningfully different from mean)
        if (Math.abs(median - mean) > (xExtent[1] - xExtent[0]) * 0.01) {
          const medianX = xScale(median);
          g.append("line")
            .attr("x1", medianX)
            .attr("x2", medianX)
            .attr("y1", 0)
            .attr("y2", innerHeight)
            .attr("stroke", CHART_WARNING)
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", "4,3");

          g.append("text")
            .attr("x", medianX + 4)
            .attr("y", 26)
            .attr("font-size", 10)
            .attr("fill", CHART_WARNING)
            .text(`中央 ${formatCompact(median)}`);
        }
      }

      // KDE curve
      if (showKde && !cumulative) {
        const domain = xScale.domain() as [number, number];
        const bandwidth = (domain[1] - domain[0]) / thresholds;
        const kde = kernelDensityEstimator(
          kernelEpanechnikov(bandwidth),
          xScale.ticks(80),
        );
        const densityData = kde(resolvedData);

        // Scale KDE to match bar counts
        const totalArea =
          ((domain[1] - domain[0]) / thresholds) * resolvedData.length;
        const kdeMax = d3.max(densityData, (d) => d[1]) ?? 1;
        const scaleFactor =
          (yMax * 0.9) /
          (((kdeMax * totalArea) / (domain[1] - domain[0])) * bandwidth);

        const kdeYScale = d3
          .scaleLinear()
          .domain([0, kdeMax])
          .range([
            innerHeight,
            innerHeight -
              (((yMax * 0.9) / ((totalArea / (domain[1] - domain[0])) * bandwidth)) *
                kdeMax),
          ]);

        // Use a simpler approach: map KDE values proportionally to yScale
        const kdeCountScale = d3
          .scaleLinear()
          .domain([0, kdeMax])
          .range([innerHeight, yScale(yMax * 0.85)]);

        void scaleFactor;
        void kdeYScale;

        const line = d3
          .line<[number, number]>()
          .x((d) => xScale(d[0]))
          .y((d) => kdeCountScale(d[1]))
          .curve(d3.curveBasis);

        g.append("path")
          .datum(densityData)
          .attr("fill", "none")
          .attr("stroke", PRIMARY())
          .attr("stroke-width", 2)
          .attr("stroke-opacity", 0.7)
          .attr("d", line);
      }
    },
    [
      resolvedData,
      thresholds,
      cumulative,
      showGrid,
      animated,
      showKde,
      showMeanLine,
      width,
      height,
      margin,
      innerWidth,
      innerHeight,
    ],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full overflow-hidden", className)}
      role="img"
      aria-label="ヒストグラムチャート"
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
