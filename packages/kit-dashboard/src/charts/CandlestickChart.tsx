import { useRef } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { getInnerDimensions } from "../lib/d3Helpers";
import { semanticColor } from "../lib/chartRoles";
import { fillFor, SHAPE_RX, HOVER_OPACITY } from "../lib/chartStyle";
import { themeAxis, themeGrid } from "../lib/d3Theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface CandlestickData {
  date: string; // e.g. "1月"
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CandlestickChartProps {
  data?: CandlestickData[];
  width?: number;
  height?: number;
  /** candle when close >= open（既定: semanticColor("positive") = 上昇） */
  bullColor?: string;
  /** candle when close < open（既定: semanticColor("negative") = 下落） */
  bearColor?: string;
  animated?: boolean;
  className?: string;
}

const DEFAULT_DATA: CandlestickData[] = [
  { date: "1月", open: 100, high: 125, low: 95, close: 118 },
  { date: "2月", open: 118, high: 130, low: 110, close: 108 },
  { date: "3月", open: 108, high: 120, low: 100, close: 115 },
  { date: "4月", open: 115, high: 140, low: 112, close: 135 },
  { date: "5月", open: 135, high: 148, low: 128, close: 142 },
  { date: "6月", open: 142, high: 155, low: 130, close: 125 },
  { date: "7月", open: 125, high: 138, low: 118, close: 130 },
  { date: "8月", open: 130, high: 145, low: 125, close: 140 },
  { date: "9月", open: 140, high: 160, low: 135, close: 155 },
  { date: "10月", open: 155, high: 170, low: 145, close: 148 },
  { date: "11月", open: 148, high: 165, low: 140, close: 160 },
  { date: "12月", open: 160, high: 175, low: 152, close: 170 },
];

const MARGIN = { top: 20, right: 20, bottom: 30, left: 50 };
// Volume area takes bottom 20% of the inner chart height
const VOLUME_RATIO = 0.2;
// Gap between main chart and volume chart (px)
const VOLUME_GAP = 8;

export function CandlestickChart({
  data = DEFAULT_DATA,
  width: propWidth,
  height = 320,
  bullColor = semanticColor("positive"),
  bearColor = semanticColor("negative"),
  animated = true,
  className,
}: CandlestickChartProps) {
  const { show, hide, containerRef, tooltipRef } = useTooltip();
  const { width: observedWidth } = useResizeObserver(containerRef);

  const width = propWidth ?? observedWidth;
  const { innerWidth, innerHeight } = getInnerDimensions(width, height, MARGIN);

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (!data.length || innerWidth <= 0 || innerHeight <= 0) return;

      svg.attr("width", width).attr("height", height);

      const g = svg
        .append("g")
        .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

      // 共通の縦グラデ defs。実体は陽/陰の semantic 色を fillFor で塗る（1色1グラデを再利用）。
      const defs = svg.append("defs");
      const bullFill = fillFor(defs, bullColor, "candle-bull");
      const bearFill = fillFor(defs, bearColor, "candle-bear");

      // --- Height split: main chart vs volume chart ---
      const volumeHeight = Math.floor(innerHeight * VOLUME_RATIO);
      const mainHeight = innerHeight - volumeHeight - VOLUME_GAP;

      // --- Scales ---
      const xScale = d3
        .scaleBand()
        .domain(data.map((d) => d.date))
        .range([0, innerWidth])
        .padding(0.2);

      const allPrices = data.flatMap((d) => [d.low, d.high]);
      const yMin = d3.min(allPrices) ?? 0;
      const yMax = d3.max(allPrices) ?? 0;

      const yScale = d3
        .scaleLinear()
        .domain([yMin, yMax])
        .nice()
        .range([mainHeight, 0]);

      // Volume scale (proxy: high - low range as volume)
      const volumes = data.map((d) => d.high - d.low);
      const vMax = d3.max(volumes) ?? 1;
      const yVolume = d3.scaleLinear().domain([0, vMax]).range([volumeHeight, 0]);

      // --- Grid lines ---
      const gridG = g
        .append("g")
        .call(
          d3
            .axisLeft(yScale)
            .tickSize(-innerWidth)
            .tickFormat(() => ""),
        );
      themeGrid(gridG);

      // --- X axis ---
      const xAxisG = g
        .append("g")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(d3.axisBottom(xScale));
      themeAxis(xAxisG);

      // --- Y axis (main) ---
      const yAxisG = g.append("g").call(d3.axisLeft(yScale).ticks(5));
      themeAxis(yAxisG);

      // --- Candle rendering ---
      const candleWidth = xScale.bandwidth() * 0.6;

      const candleGroup = g.append("g").attr("class", "candles");

      data.forEach((d) => {
        const x = (xScale(d.date) ?? 0) + xScale.bandwidth() / 2;
        const isBull = d.close >= d.open;
        const color = isBull ? bullColor : bearColor; // 芯線（wick）用の flat ロール色
        const bodyFill = isBull ? bullFill : bearFill; // 実体用の共通縦グラデ

        const bodyTop = yScale(Math.max(d.open, d.close));
        const bodyBottom = yScale(Math.min(d.open, d.close));
        const bodyHeight = Math.max(1, bodyBottom - bodyTop); // at least 1px

        const candleG = candleGroup
          .append("g")
          .attr("class", "candle-group")
          .style("cursor", "pointer")
          .datum(d);

        // Wick: high to low
        candleG
          .append("line")
          .attr("class", "candle-wick")
          .style("pointer-events", "none")
          .attr("x1", x)
          .attr("x2", x)
          .attr("y1", yScale(d.high))
          .attr("y2", yScale(d.low))
          .attr("stroke", color)
          .attr("stroke-width", 1.5);

        // Body: open to close
        const bodyRect = candleG
          .append("rect")
          .attr("class", "candle-body")
          .style("pointer-events", "none")
          .attr("x", x - candleWidth / 2)
          .attr("width", candleWidth)
          .attr("rx", SHAPE_RX)
          .attr("fill", bodyFill)
          .attr("stroke", "none");

        if (animated) {
          // Animate from midpoint (open) expanding to full body
          bodyRect
            .attr("y", yScale(d.open))
            .attr("height", 0)
            .transition()
            .duration(500)
            .delay((_, i) => i * 40)
            .ease(d3.easeCubicOut)
            .attr("y", bodyTop)
            .attr("height", bodyHeight);
        } else {
          bodyRect.attr("y", bodyTop).attr("height", bodyHeight);
        }

        // Hover overlay (transparent rect over full candle range for easy hit target)
        const hoverTop = yScale(d.high);
        const hoverBottom = yScale(d.low);
        candleG
          .append("rect")
          .attr("class", "candle-hover-target")
          .style("cursor", "crosshair")
          .attr("x", x - xScale.bandwidth() / 2)
          .attr("width", xScale.bandwidth())
          .attr("y", hoverTop)
          .attr("height", Math.max(1, hoverBottom - hoverTop))
          .attr("fill", "transparent")
          .on("mouseenter", function (event: MouseEvent) {
            d3.select(this.parentNode as SVGGElement)
              .selectAll<SVGElement, unknown>(".candle-body, .candle-wick")
              .attr("opacity", HOVER_OPACITY);
            show(
              event,
              `${d.date}  O: ${d.open}  H: ${d.high}  L: ${d.low}  C: ${d.close}`,
            );
          })
          .on("mouseleave", function () {
            d3.select(this.parentNode as SVGGElement)
              .selectAll<SVGElement, unknown>(".candle-body, .candle-wick")
              .attr("opacity", 1);
            hide();
          });
      });

      // --- Volume bars (bottom section) ---
      const volumeOffsetY = mainHeight + VOLUME_GAP;

      g.selectAll<SVGRectElement, CandlestickData>(".vol-bar")
        .data(data)
        .join("rect")
        .attr("class", "vol-bar")
        .attr(
          "x",
          (d) => (xScale(d.date) ?? 0) + (xScale.bandwidth() - candleWidth) / 2,
        )
        .attr("width", candleWidth)
        .attr("rx", SHAPE_RX)
        .attr("fill", (d) => (d.close >= d.open ? bullColor : bearColor))
        .attr("opacity", 0.4)
        .attr("y", volumeOffsetY + volumeHeight) // start collapsed at bottom
        .attr("height", 0)
        .call((sel) => {
          if (animated) {
            sel
              .transition()
              .duration(500)
              .ease(d3.easeCubicOut)
              .attr("y", (d) => volumeOffsetY + yVolume(d.high - d.low))
              .attr("height", (d) => volumeHeight - yVolume(d.high - d.low));
          } else {
            sel
              .attr("y", (d) => volumeOffsetY + yVolume(d.high - d.low))
              .attr("height", (d) => volumeHeight - yVolume(d.high - d.low));
          }
        });
    },
    [data, width, height, bullColor, bearColor, animated, innerWidth, innerHeight],
  );

  return (
    <div ref={containerRef} className={cn("relative w-full overflow-hidden", className)}>
      <svg ref={svgRef} />
      <ChartTooltip ref={tooltipRef} />
    </div>
  );
}
