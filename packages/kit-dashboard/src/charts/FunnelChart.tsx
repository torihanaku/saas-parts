import { useRef } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { getInnerDimensions } from "../lib/d3Helpers";
import { getChartColor, getColorScheme } from "../lib/colorUtils";
import { formatNumber } from "../lib/formatters";
import { CHART_TEXT, CHART_TEXT_MUTED, CHART_NEGATIVE } from "../lib/theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface FunnelStep {
  label: string;
  value: number;
  color?: string;
}

export interface FunnelChartProps {
  data?: FunnelStep[];
  width?: number;
  height?: number;
  shape?: "trapezoid" | "step";
  showRate?: boolean;
  animated?: boolean;
  className?: string;
  colorScheme?: string;
  fillGradient?: boolean;
  dataCategory?: string;
}

// ----------------------------------------------------------------
// Category-specific funnel datasets
// ----------------------------------------------------------------
const FUNNEL_BY_CATEGORY: Record<string, FunnelStep[]> = {
  leads: [
    { label: "MQL", value: 1200 },
    { label: "SQL", value: 744 },
    { label: "商談", value: 372 },
    { label: "提案", value: 186 },
    { label: "成約", value: 108 },
  ],
  pipeline: [
    { label: "リード", value: 2000 },
    { label: "問い合わせ", value: 960 },
    { label: "商談", value: 480 },
    { label: "契約", value: 192 },
  ],
  marketing: [
    { label: "認知", value: 10000 },
    { label: "検討", value: 3200 },
    { label: "購入", value: 640 },
    { label: "リピート", value: 256 },
  ],
};

const DEFAULT_DATA: FunnelStep[] = FUNNEL_BY_CATEGORY.leads!;

// Margin giving extra right space for labels
const FUNNEL_MARGIN = { top: 20, right: 160, bottom: 20, left: 20 };

// Height reserved between funnel steps for the drop-off indicator
const DROPOFF_GAP = 20;

export function FunnelChart({
  data,
  width: propWidth,
  height = 340,
  shape = "trapezoid",
  showRate = true,
  animated = true,
  className,
  colorScheme,
  fillGradient = false,
  dataCategory,
}: FunnelChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { state: tooltipState, show, hide } = useTooltip();

  // Resolve data: explicit prop > dataCategory lookup > default
  const resolvedData =
    data ??
    (dataCategory ? FUNNEL_BY_CATEGORY[dataCategory] : undefined) ??
    DEFAULT_DATA;

  const width = propWidth ?? observedWidth;
  const margin = FUNNEL_MARGIN;
  const { innerWidth, innerHeight } = getInnerDimensions(width, height, margin);

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (!resolvedData.length || innerWidth <= 0 || innerHeight <= 0) return;

      svg.attr("width", width).attr("height", height);

      const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      // colorScheme override
      const schemeColors = colorScheme ? getColorScheme(colorScheme) : null;
      const resolveColor = (index: number, perItemColor?: string) =>
        perItemColor ??
        schemeColors?.[index % schemeColors.length] ??
        getChartColor(index);

      // gradient defs (used when fillGradient=true)
      const defsEl = svg.append("defs");

      const maxValue = d3.max(resolvedData, (d) => d.value) ?? 1;
      const stepCount = resolvedData.length;
      const GAP = 4;
      // Each step has its trapezoid height + drop-off gap (except the last)
      const totalGapHeight = DROPOFF_GAP * (stepCount - 1);
      const availableForBars = innerHeight - GAP * (stepCount - 1) - totalGapHeight;
      const stepHeight = availableForBars / stepCount;

      // Compute bar widths for each step
      const barWidths = resolvedData.map((d) => (d.value / maxValue) * innerWidth);

      // Draw each funnel step
      resolvedData.forEach((d, i) => {
        const topWidth = barWidths[i]!;
        const bottomWidth =
          shape === "trapezoid"
            ? i < stepCount - 1
              ? barWidths[i + 1]!
              : topWidth * 0.75
            : topWidth;

        // yTop accounts for step height + gap + drop-off gap rows above
        const yTop = i * (stepHeight + GAP + DROPOFF_GAP);
        const yBottom = yTop + stepHeight;
        const cx = innerWidth / 2;

        const fill = resolveColor(i, d.color);

        // gradient def for this step
        if (fillGradient) {
          const grad = defsEl
            .append("linearGradient")
            .attr("id", `funnel-grad-${i}`)
            .attr("x1", "0")
            .attr("y1", "0")
            .attr("x2", "1")
            .attr("y2", "0");
          grad
            .append("stop")
            .attr("offset", "0%")
            .attr("stop-color", fill)
            .attr("stop-opacity", 0.6);
          grad
            .append("stop")
            .attr("offset", "50%")
            .attr("stop-color", fill)
            .attr("stop-opacity", 1);
          grad
            .append("stop")
            .attr("offset", "100%")
            .attr("stop-color", fill)
            .attr("stop-opacity", 0.6);
        }

        let pathD: string;
        if (shape === "trapezoid") {
          const tlX = cx - topWidth / 2;
          const trX = cx + topWidth / 2;
          const brX = cx + bottomWidth / 2;
          const blX = cx - bottomWidth / 2;
          pathD = `M ${tlX} ${yTop} L ${trX} ${yTop} L ${brX} ${yBottom} L ${blX} ${yBottom} Z`;
        } else {
          const x = cx - topWidth / 2;
          pathD = `M ${x} ${yTop} L ${x + topWidth} ${yTop} L ${x + topWidth} ${yBottom} L ${x} ${yBottom} Z`;
        }

        const bar = g
          .append("path")
          .attr("class", "funnel-bar")
          .style("cursor", "pointer")
          .attr("fill", fillGradient ? `url(#funnel-grad-${i})` : fill)
          .attr("opacity", 1);

        if (animated) {
          const centerPath = `M ${cx} ${yTop} L ${cx} ${yTop} L ${cx} ${yBottom} L ${cx} ${yBottom} Z`;

          bar
            .attr("d", centerPath)
            .transition()
            .duration(600)
            .delay(i * 80)
            .ease(d3.easeCubicOut)
            .attr("d", pathD);
        } else {
          bar.attr("d", pathD);
        }

        // Hover events
        bar
          .on("mouseenter", function (event: MouseEvent) {
            d3.select(this).attr("opacity", 0.8);
            show(event, `${d.label}: ${formatNumber(d.value, 0)}`);
          })
          .on("mouseleave", function () {
            d3.select(this).attr("opacity", 1);
            hide();
          });

        // ── Value label inside the segment ──────────────────────────
        const segMidY = yTop + stepHeight / 2;
        g.append("text")
          .attr("x", cx)
          .attr("y", segMidY)
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "middle")
          .style("pointer-events", "none")
          .style("user-select", "none")
          .style("text-shadow", "0 1px 2px rgba(0, 0, 0, 0.4)")
          .attr("font-size", "13px")
          .attr("font-weight", "600")
          .attr("fill", "#ffffff")
          .text(formatNumber(d.value, 0));

        // ── Right-side label ────────────────────────────────────────
        const labelX = innerWidth + 8;
        const labelY = segMidY;

        g.append("text")
          .attr("x", labelX)
          .attr("y", labelY)
          .attr("dominant-baseline", "middle")
          .style("pointer-events", "none")
          .style("user-select", "none")
          .attr("font-size", "13px")
          .attr("fill", CHART_TEXT)
          .text(d.label);

        // ── Drop-off indicator between this step and next ───────────
        if (showRate && i < stepCount - 1) {
          const dropOffY = yBottom + GAP + DROPOFF_GAP / 2;
          const convRate = (resolvedData[i + 1]!.value / d.value) * 100;
          const dropRate = 100 - convRate;

          // Connecting lines from trapezoid bottom edges down to next step
          const nextTopWidth = barWidths[i + 1]!;
          const nextTopY = yBottom + GAP + DROPOFF_GAP;

          // Draw thin connector lines on each side
          g.append("line")
            .attr("x1", cx - bottomWidth / 2)
            .attr("y1", yBottom)
            .attr("x2", cx - nextTopWidth / 2)
            .attr("y2", nextTopY)
            .attr("stroke", fill)
            .attr("stroke-width", 0.5)
            .attr("stroke-opacity", 0.3)
            .attr("pointer-events", "none");

          g.append("line")
            .attr("x1", cx + bottomWidth / 2)
            .attr("y1", yBottom)
            .attr("x2", cx + nextTopWidth / 2)
            .attr("y2", nextTopY)
            .attr("stroke", fill)
            .attr("stroke-width", 0.5)
            .attr("stroke-opacity", 0.3)
            .attr("pointer-events", "none");

          // Drop-off label — "▼ 35.7% drop" centered in the gap
          const dropGroup = g.append("g").attr("pointer-events", "none");

          dropGroup
            .append("text")
            .attr("x", cx)
            .attr("y", dropOffY - 4)
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "middle")
            .attr("font-size", "11px")
            .attr("fill", CHART_NEGATIVE)
            .attr("font-weight", "600")
            .text(`▼ ${dropRate.toFixed(1)}% drop`);

          // Conversion rate on the right of the connector zone
          g.append("text")
            .attr("x", labelX)
            .attr("y", dropOffY)
            .attr("dominant-baseline", "middle")
            .attr("font-size", "11px")
            .attr("fill", CHART_TEXT_MUTED)
            .text(`→ ${convRate.toFixed(1)}%`);
        }
      });
    },
    [
      resolvedData,
      width,
      height,
      shape,
      showRate,
      animated,
      innerWidth,
      innerHeight,
      colorScheme,
      fillGradient,
      dataCategory,
    ],
  );

  return (
    <div ref={containerRef} className={cn("relative w-full overflow-visible", className)}>
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
