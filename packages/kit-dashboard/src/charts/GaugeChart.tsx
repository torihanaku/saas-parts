import { useRef } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { formatNumber } from "../lib/formatters";
import { semanticColor, PRIMARY } from "../lib/chartRoles";
import {
  CHART_TEXT,
  CHART_TEXT_MUTED,
  CHART_BORDER,
  CHART_SURFACE,
} from "../lib/theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface GaugeRange {
  from: number;
  to: number;
  color: string;
  label?: string;
}

export interface GaugeChartProps {
  value?: number;
  min?: number;
  max?: number;
  ranges?: GaugeRange[];
  showTarget?: boolean;
  targetValue?: number;
  title?: string;
  unit?: string;
  animated?: boolean;
  width?: number;
  height?: number;
  className?: string;
  // Multi-zone threshold props (Looker Studio style)
  thresholdBad?: number; // below this = red zone
  thresholdGood?: number; // above this = green zone
  showZones?: boolean; // show colored arc zones (default: true)
}

const DEFAULT_RANGES: GaugeRange[] = [
  { from: 0, to: 60, color: semanticColor("negative"), label: "要改善" },
  { from: 60, to: 80, color: semanticColor("warning"), label: "普通" },
  { from: 80, to: 100, color: semanticColor("positive"), label: "良好" },
];

// Gauge arc spans -140deg to +140deg (280deg total)
const START_ANGLE = (-140 * Math.PI) / 180;
const END_ANGLE = (140 * Math.PI) / 180;

function valueToAngle(value: number, min: number, max: number): number {
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return START_ANGLE + t * (END_ANGLE - START_ANGLE);
}

function rangeColor(value: number, ranges: GaugeRange[]): string {
  for (const r of ranges) {
    if (value >= r.from && value <= r.to) return r.color;
  }
  return PRIMARY();
}

export function GaugeChart({
  value = 75,
  min = 0,
  max = 100,
  ranges = DEFAULT_RANGES,
  showTarget = false,
  targetValue,
  title,
  unit,
  animated = true,
  width: propWidth,
  height = 220,
  className,
  thresholdBad,
  thresholdGood,
  showZones = true,
}: GaugeChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { state: tooltipState, show, hide } = useTooltip();

  const width = propWidth ?? observedWidth;

  // Compute effective zone ranges when thresholdBad/thresholdGood are provided
  const effectiveZoneRanges: GaugeRange[] | null =
    showZones && (thresholdBad !== undefined || thresholdGood !== undefined)
      ? (() => {
          const bad = thresholdBad ?? max * 0.33;
          const good = thresholdGood ?? max * 0.66;
          return [
            { from: min, to: bad, color: semanticColor("negative"), label: "要改善" },
            { from: bad, to: good, color: semanticColor("warning"), label: "普通" },
            { from: good, to: max, color: semanticColor("positive"), label: "良好" },
          ];
        })()
      : null;

  const activeRanges = effectiveZoneRanges ?? ranges;

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (width <= 0 || height <= 0) return;

      svg.attr("width", width).attr("height", height);

      // Center x at midpoint; center y at 68% of height so the arc sits above text
      const cx = width / 2;
      const cy = height * 0.68;

      // Outer radius scales with whichever dimension is smaller
      const outerRadius = Math.min(width * 0.5, height * 1.2) * 0.4;
      const innerRadius = outerRadius * 0.7;
      const arcThickness = outerRadius - innerRadius;

      // Arc generator
      const arc = d3
        .arc<{ startAngle: number; endAngle: number }>()
        .innerRadius(innerRadius)
        .outerRadius(outerRadius)
        .startAngle((d) => d.startAngle)
        .endAngle((d) => d.endAngle);

      const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

      // Background track arc
      g.append("path")
        .datum({ startAngle: START_ANGLE, endAngle: END_ANGLE })
        .attr("d", arc)
        .attr("fill", CHART_BORDER);

      // Range arcs (zone-based or legacy ranges)
      if (effectiveZoneRanges !== null && showZones) {
        // Draw solid colored zone segments (Looker Studio style)
        effectiveZoneRanges.forEach((r) => {
          const rStart = valueToAngle(r.from, min, max);
          const rEnd = valueToAngle(r.to, min, max);
          g.append("path")
            .datum({ startAngle: rStart, endAngle: rEnd })
            .attr("d", arc)
            .attr("fill", r.color)
            .attr("opacity", 0.4);
        });
      } else if (activeRanges.length > 0) {
        activeRanges.forEach((r) => {
          const rStart = valueToAngle(r.from, min, max);
          const rEnd = valueToAngle(r.to, min, max);
          g.append("path")
            .datum({ startAngle: rStart, endAngle: rEnd })
            .attr("d", arc)
            .attr("fill", r.color)
            .attr("opacity", 0.25);
        });
      }

      // Determine value arc color
      const valueAngle = valueToAngle(value, min, max);
      const fillColor =
        activeRanges.length > 0 ? rangeColor(value, activeRanges) : PRIMARY();

      // Value arc — animated or static
      const valuePath = g
        .append("path")
        .attr("fill", fillColor)
        .style("cursor", "pointer")
        .on("mouseenter", function (event: MouseEvent) {
          show(event, `${title ?? "値"}: ${formatNumber(value, 0)}${unit ?? ""}`);
        })
        .on("mouseleave", () => hide());

      if (animated) {
        // attrTween animates from startAngle to valueAngle
        valuePath
          .datum({ startAngle: START_ANGLE, endAngle: START_ANGLE })
          .attr("d", arc)
          .transition()
          .duration(900)
          .ease(d3.easeCubicOut)
          .attrTween("d", function () {
            const interpolate = d3.interpolate(START_ANGLE, valueAngle);
            return function (t: number) {
              return arc({ startAngle: START_ANGLE, endAngle: interpolate(t) }) ?? "";
            };
          });
      } else {
        valuePath
          .datum({ startAngle: START_ANGLE, endAngle: valueAngle })
          .attr("d", arc);
      }

      // Target marker line
      if (showTarget && targetValue !== undefined) {
        const tAngle = valueToAngle(targetValue, min, max);
        const markerInner = innerRadius - 4;
        const markerOuter = outerRadius + 4;
        const cos = Math.cos(tAngle - Math.PI / 2);
        const sin = Math.sin(tAngle - Math.PI / 2);
        g.append("line")
          .attr("x1", cos * markerInner)
          .attr("y1", sin * markerInner)
          .attr("x2", cos * markerOuter)
          .attr("y2", sin * markerOuter)
          .attr("stroke", CHART_TEXT)
          .attr("stroke-width", 2)
          .attr("stroke-linecap", "round");
      }

      // Min / max tick labels
      const labelOffset = outerRadius + 16;
      const startCos = Math.cos(START_ANGLE - Math.PI / 2);
      const startSin = Math.sin(START_ANGLE - Math.PI / 2);
      const endCos = Math.cos(END_ANGLE - Math.PI / 2);
      const endSin = Math.sin(END_ANGLE - Math.PI / 2);

      g.append("text")
        .attr("x", startCos * labelOffset)
        .attr("y", startSin * labelOffset)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "middle")
        .attr("font-size", "11px")
        .attr("fill", CHART_TEXT_MUTED)
        .text(String(min));

      g.append("text")
        .attr("x", endCos * labelOffset)
        .attr("y", endSin * labelOffset)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "middle")
        .attr("font-size", "11px")
        .attr("fill", CHART_TEXT_MUTED)
        .text(String(max));

      // ── Needle pointer ──────────────────────────────────────────────
      const needleLength = outerRadius + 4;
      const needleBaseWidth = arcThickness * 0.25;
      // Needle tip coords (rotated by valueAngle - 90deg because D3 arc 0 = top)
      const needleAngle = valueAngle - Math.PI / 2;
      const tipX = Math.cos(needleAngle) * needleLength;
      const tipY = Math.sin(needleAngle) * needleLength;
      // Perpendicular base points
      const perpX = Math.cos(needleAngle + Math.PI / 2) * needleBaseWidth;
      const perpY = Math.sin(needleAngle + Math.PI / 2) * needleBaseWidth;

      g.append("path")
        .attr("d", `M ${-perpX} ${-perpY} L ${tipX} ${tipY} L ${perpX} ${perpY} Z`)
        .attr("fill", CHART_TEXT)
        .attr("opacity", 0.85);

      // Center dot over needle base
      g.append("circle")
        .attr("cx", 0)
        .attr("cy", 0)
        .attr("r", arcThickness * 0.22)
        .attr("fill", CHART_SURFACE)
        .attr("stroke", CHART_TEXT)
        .attr("stroke-width", 1.5);

      // ── Center value display ─────────────────────────────────────────
      // Show percentage: value/max * 100
      const pct = Math.round(((value - min) / (max - min)) * 100);

      g.append("text")
        .attr("x", 0)
        .attr("y", innerRadius * 0.15)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .style("pointer-events", "none")
        .style("user-select", "none")
        .attr("font-size", outerRadius * 0.45)
        .attr("font-weight", "700")
        .attr("fill", fillColor)
        .text(`${formatNumber(value, 0)}${unit ?? ""}`);

      // Percentage sub-label
      g.append("text")
        .attr("x", 0)
        .attr("y", innerRadius * 0.15 + outerRadius * 0.32)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "central")
        .attr("font-size", "11px")
        .attr("fill", CHART_TEXT_MUTED)
        .text(`${pct}% / ${formatNumber(max, 0)}${unit ?? ""}`);

      // Title below the value
      if (title) {
        g.append("text")
          .attr("x", 0)
          .attr("y", outerRadius * 0.48)
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "hanging")
          .attr("font-size", "13px")
          .attr("fill", CHART_TEXT_MUTED)
          .text(title);
      }

      // Range legend below the arc
      if (activeRanges.length > 0) {
        const legendY = outerRadius * 0.9 + (title ? 24 : 8);
        const legendSpacing = Math.min(80, (width - 32) / activeRanges.length);
        const legendStartX = -(((activeRanges.length - 1) * legendSpacing) / 2);

        activeRanges.forEach((r, i) => {
          const lx = legendStartX + i * legendSpacing;
          const dotR = arcThickness * 0.25;

          g.append("circle")
            .attr("cx", lx - dotR * 1.6)
            .attr("cy", legendY + dotR)
            .attr("r", dotR)
            .attr("fill", r.color);

          g.append("text")
            .attr("x", lx)
            .attr("y", legendY + dotR)
            .attr("dominant-baseline", "central")
            .attr("font-size", "11px")
            .attr("fill", CHART_TEXT_MUTED)
            .text(r.label ?? `${r.from}–${r.to}`);
        });
      }
    },
    [
      value,
      min,
      max,
      ranges,
      showTarget,
      targetValue,
      title,
      unit,
      animated,
      width,
      height,
      thresholdBad,
      thresholdGood,
      showZones,
      effectiveZoneRanges,
      activeRanges,
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
