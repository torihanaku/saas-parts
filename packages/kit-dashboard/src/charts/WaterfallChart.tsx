import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { getInnerDimensions } from "../lib/d3Helpers";
import { formatNumber } from "../lib/formatters";
import { semanticColor, PRIMARY } from "../lib/chartRoles";
import { SHAPE_RX, fillFor } from "../lib/chartStyle";
import {
  CHART_BORDER,
  CHART_TEXT_MUTED,
  CHART_WARNING,
} from "../lib/theme";
import { themeAxis, themeGrid } from "../lib/d3Theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export type WaterfallItemType = "increase" | "decrease" | "total" | "subtotal";

export interface WaterfallItem {
  label: string;
  value: number;
  type?: WaterfallItemType;
  color?: string;
}

export interface WaterfallChartProps {
  data?: WaterfallItem[];
  width?: number;
  height?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  showLabels?: boolean;
  showGrid?: boolean;
  showRunningTotal?: boolean;
  animated?: boolean;
  className?: string;
}

const DEFAULT_DATA: WaterfallItem[] = [
  { label: "前期ARR", value: 800, type: "total" },
  { label: "新規", value: 180 },
  { label: "拡張", value: 95 },
  { label: "チャーン", value: -65 },
  { label: "ダウン", value: -30 },
  { label: "今期ARR", value: 980, type: "total" },
];

const DEFAULT_MARGIN = { top: 20, right: 20, bottom: 40, left: 60 };

interface WaterfallSegment {
  label: string;
  value: number;
  resolvedType: WaterfallItemType;
  barStart: number;
  barEnd: number;
  color: string;
}

function computeSegments(data: WaterfallItem[]): WaterfallSegment[] {
  let runningTotal = 0;
  const segments: WaterfallSegment[] = [];

  for (let i = 0; i < data.length; i++) {
    const item = data[i]!;
    const isTotal = item.type === "total" || item.type === "subtotal";

    let resolvedType: WaterfallItemType;
    if (item.type) {
      resolvedType = item.type;
    } else {
      resolvedType = item.value >= 0 ? "increase" : "decrease";
    }

    if (isTotal) {
      const displayValue = item.value !== 0 ? item.value : runningTotal;
      segments.push({
        label: item.label,
        value: displayValue,
        resolvedType,
        barStart: 0,
        barEnd: displayValue,
        // subtotal: muted, total: 主系列色（PRIMARY = chart-1）
        color:
          item.color ??
          (item.type === "subtotal" ? CHART_TEXT_MUTED : PRIMARY()),
      });
      runningTotal = displayValue;
    } else {
      const previousTotal = runningTotal;
      runningTotal += item.value;

      const barStart = Math.min(previousTotal, runningTotal);
      const barEnd = Math.max(previousTotal, runningTotal);

      segments.push({
        label: item.label,
        value: item.value,
        resolvedType,
        barStart,
        barEnd,
        color:
          item.color ??
          semanticColor(resolvedType === "increase" ? "positive" : "negative"),
      });
    }
  }

  return segments;
}

export function WaterfallChart({
  data = DEFAULT_DATA,
  width: propWidth,
  height = 320,
  margin = DEFAULT_MARGIN,
  showLabels = true,
  showGrid = true,
  showRunningTotal = false,
  animated = true,
  className,
}: WaterfallChartProps) {
  const { show, hide, containerRef, tooltipRef } = useTooltip();
  const { width: observedWidth } = useResizeObserver(containerRef);

  const width = propWidth ?? observedWidth;
  const { innerWidth, innerHeight } = getInnerDimensions(width, height, margin);

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (!data.length || innerWidth <= 0 || innerHeight <= 0) return;

      const segments = computeSegments(data);

      svg.attr("width", width).attr("height", height);

      const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      // --- Scales ---
      const xScale = d3
        .scaleBand()
        .domain(segments.map((s) => s.label))
        .range([0, innerWidth])
        .padding(0.2);

      const allValues = segments.flatMap((s) => [s.barStart, s.barEnd]);
      const yMin = Math.min(0, d3.min(allValues) ?? 0);
      const yMax = d3.max(allValues) ?? 0;

      const yScale = d3
        .scaleLinear()
        .domain([yMin, yMax])
        .nice()
        .range([innerHeight, 0]);

      // --- Grid lines ---
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

      // --- Zero baseline ---
      const zeroY = yScale(0);
      g.append("line")
        .attr("x1", 0)
        .attr("x2", innerWidth)
        .attr("y1", zeroY)
        .attr("y2", zeroY)
        .attr("stroke", CHART_BORDER)
        .attr("stroke-width", 1);

      // --- X axis ---
      const xAxisG = g
        .append("g")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(d3.axisBottom(xScale));
      themeAxis(xAxisG);

      // --- Y axis ---
      const yAxisG = g
        .append("g")
        .call(d3.axisLeft(yScale).tickFormat((d) => formatNumber(d as number, 0)));
      themeAxis(yAxisG);

      // --- Connector lines (drawn before bars so bars render on top) ---
      for (let i = 0; i < segments.length - 1; i++) {
        const curr = segments[i]!;
        const next = segments[i + 1]!;

        const currX = (xScale(curr.label) ?? 0) + xScale.bandwidth();
        const nextX = xScale(next.label) ?? 0;
        const connectorY = yScale(curr.barEnd);

        g.append("line")
          .attr("x1", currX)
          .attr("x2", nextX)
          .attr("y1", connectorY)
          .attr("y2", connectorY)
          .attr("stroke", CHART_BORDER)
          .attr("stroke-dasharray", "4 2")
          .attr("stroke-width", 1)
          .attr("fill", "none");
      }

      // --- Bars ---
      // ベタ塗り回避: 共通の標準塗り fillFor（縦グラデ）。hue は色ロール（意味/主系列/muted）で決める。
      const barDefs = svg.append("defs");
      const fillByColor = new Map<string, string>();
      const segFill = (color: string): string => {
        let url = fillByColor.get(color);
        if (!url) {
          url = fillFor(barDefs, color, `wf-fill-${fillByColor.size}`);
          fillByColor.set(color, url);
        }
        return url;
      };

      const barGroups = g
        .selectAll<SVGRectElement, WaterfallSegment>(".wf-bar")
        .data(segments)
        .join("rect")
        .attr("class", "wf-bar")
        .style("cursor", "pointer")
        .attr("x", (s) => xScale(s.label) ?? 0)
        .attr("width", xScale.bandwidth())
        .attr("rx", SHAPE_RX)
        .attr("fill", (s) => segFill(s.color))
        .attr("y", (s) => yScale(s.barStart))
        .attr("height", 0);

      if (animated) {
        barGroups
          .transition()
          .duration(600)
          .ease(d3.easeCubicOut)
          .attr("y", (s) => yScale(s.barEnd))
          .attr("height", (s) => Math.abs(yScale(s.barStart) - yScale(s.barEnd)));
      } else {
        barGroups
          .attr("y", (s) => yScale(s.barEnd))
          .attr("height", (s) => Math.abs(yScale(s.barStart) - yScale(s.barEnd)));
      }

      // --- Value labels ---
      if (showLabels) {
        g.selectAll(".wf-label")
          .data(segments)
          .join("text")
          .attr("class", "wf-label")
          .attr("x", (s) => (xScale(s.label) ?? 0) + xScale.bandwidth() / 2)
          .attr("y", (s) => yScale(s.barEnd) - 5)
          .attr("text-anchor", "middle")
          .attr("font-size", "11px")
          .attr("fill", CHART_TEXT_MUTED)
          .text((s) => {
            const isTotal =
              s.resolvedType === "total" || s.resolvedType === "subtotal";
            if (isTotal) return formatNumber(s.value, 0);
            return s.value >= 0
              ? `+${formatNumber(s.value, 0)}`
              : formatNumber(s.value, 0);
          });

        const totalSegments = segments.filter(
          (s) => s.resolvedType === "total" || s.resolvedType === "subtotal",
        );
        g.selectAll(".wf-total-badge")
          .data(totalSegments)
          .join("text")
          .attr("class", "wf-total-badge")
          .attr("x", (s) => (xScale(s.label) ?? 0) + xScale.bandwidth() / 2)
          .attr("y", (s) => yScale(s.barEnd) - 16)
          .attr("text-anchor", "middle")
          .attr("font-size", "9px")
          .attr("fill", CHART_TEXT_MUTED)
          .text("合計");
      }

      // --- Subtotal bracket lines ---
      const subtotalSegs = segments.filter((s) => s.resolvedType === "subtotal");
      g.selectAll(".wf-subtotal-cap")
        .data(subtotalSegs)
        .join("line")
        .attr("class", "wf-subtotal-cap")
        .attr("x1", (s) => (xScale(s.label) ?? 0) - 4)
        .attr("x2", (s) => (xScale(s.label) ?? 0) + xScale.bandwidth() + 4)
        .attr("y1", (s) => yScale(s.barEnd))
        .attr("y2", (s) => yScale(s.barEnd))
        .attr("stroke", CHART_TEXT_MUTED)
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", "0");

      // --- Running total line (optional) ---
      if (showRunningTotal) {
        const linePoints = segments.map((s) => ({
          cx: (xScale(s.label) ?? 0) + xScale.bandwidth() / 2,
          cy: yScale(s.barEnd),
        }));
        const lineGen = d3
          .line<{ cx: number; cy: number }>()
          .x((d) => d.cx)
          .y((d) => d.cy)
          .curve(d3.curveMonotoneX);

        g.append("path")
          .datum(linePoints)
          .attr("class", "wf-running-total")
          .attr("d", lineGen)
          .attr("fill", "none")
          .attr("stroke", CHART_WARNING)
          .attr("stroke-width", 2)
          .attr("stroke-dasharray", "5 3")
          .attr("pointer-events", "none");

        g.selectAll(".wf-rt-dot")
          .data(linePoints)
          .join("circle")
          .attr("class", "wf-rt-dot")
          .attr("cx", (d) => d.cx)
          .attr("cy", (d) => d.cy)
          .attr("r", 3)
          .attr("fill", CHART_WARNING)
          .attr("pointer-events", "none");
      }

      // --- Hover events ---
      barGroups
        .on("mouseenter", function (event: MouseEvent, s) {
          d3.select(this).attr("opacity", 0.8);
          const isTotal =
            s.resolvedType === "total" || s.resolvedType === "subtotal";
          const label = isTotal
            ? `${s.label}: ${formatNumber(s.value, 0)}`
            : `${s.label}: ${s.value >= 0 ? "+" : ""}${formatNumber(s.value, 0)}`;
          show(event, label);
        })
        .on("mouseleave", function () {
          d3.select(this).attr("opacity", 1);
          hide();
        });
    },
    [
      data,
      width,
      height,
      showLabels,
      showGrid,
      showRunningTotal,
      animated,
      innerWidth,
      innerHeight,
    ],
  );

  return (
    <div ref={containerRef} className={cn("relative w-full overflow-hidden", className)}>
      <svg ref={svgRef} />
      <ChartTooltip ref={tooltipRef} />
    </div>
  );
}
