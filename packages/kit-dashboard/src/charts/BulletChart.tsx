import { useRef } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { formatNumber } from "../lib/formatters";
import { getChartColor } from "../lib/colorUtils";
import {
  CHART_TEXT,
  CHART_TEXT_MUTED,
  CHART_BORDER,
  CHART_POSITIVE,
  CHART_NEGATIVE,
  CHART_WARNING,
} from "../lib/theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface BulletRange {
  from: number;
  to: number;
  color: string;
  label?: string;
}

export interface BulletItem {
  label: string;
  value: number;
  target: number;
  max: number;
  ranges?: BulletRange[];
  unit?: string;
}

export interface BulletChartProps {
  items?: BulletItem[];
  width?: number;
  barHeight?: number;
  className?: string;
  dataCategory?: string;
}

// ----------------------------------------------------------------
// Three-band ranges helper（テーマ追従の意味トークンで着色）
// 要改善→negative / 普通→warning / 良好→positive の淡色帯。
// var(...) を stroke-opacity で薄く敷く（元の pastel hex の代替）。
// ----------------------------------------------------------------
function makeBands(poor: number, ok: number, max: number): BulletRange[] {
  return [
    { from: 0, to: poor, color: CHART_NEGATIVE, label: "要改善" },
    { from: poor, to: ok, color: CHART_WARNING, label: "普通" },
    { from: ok, to: max, color: CHART_POSITIVE, label: "良好" },
  ];
}

// ----------------------------------------------------------------
// Category-specific datasets
// ----------------------------------------------------------------
const ITEMS_BY_CATEGORY: Record<string, BulletItem[]> = {
  leads: [
    {
      label: "MQL獲得数",
      value: 820,
      target: 1000,
      max: 1200,
      unit: "件",
      ranges: makeBands(400, 800, 1200),
    },
    {
      label: "SQLコンバート",
      value: 42,
      target: 50,
      max: 60,
      unit: "%",
      ranges: makeBands(20, 40, 60),
    },
    {
      label: "商談化率",
      value: 34,
      target: 40,
      max: 50,
      unit: "%",
      ranges: makeBands(15, 30, 50),
    },
    {
      label: "成約率",
      value: 22,
      target: 30,
      max: 40,
      unit: "%",
      ranges: makeBands(10, 20, 40),
    },
  ],
  pipeline: [
    {
      label: "パイプライン総額",
      value: 420,
      target: 500,
      max: 600,
      unit: "M",
      ranges: makeBands(200, 380, 600),
    },
    {
      label: "ARR達成率",
      value: 82,
      target: 100,
      max: 120,
      unit: "%",
      ranges: makeBands(40, 75, 120),
    },
    {
      label: "平均商談額",
      value: 3.2,
      target: 4.0,
      max: 5.0,
      unit: "M",
      ranges: makeBands(1.5, 2.8, 5.0),
    },
  ],
  marketing: [
    {
      label: "CVR",
      value: 3.8,
      target: 5.0,
      max: 8.0,
      unit: "%",
      ranges: makeBands(1.5, 3.5, 8.0),
    },
    {
      label: "CPA",
      value: 12800,
      target: 10000,
      max: 20000,
      unit: "円",
      ranges: makeBands(0, 10000, 20000),
    },
    {
      label: "ROAS",
      value: 320,
      target: 400,
      max: 600,
      unit: "%",
      ranges: makeBands(150, 300, 600),
    },
  ],
};

const DEFAULT_ITEMS: BulletItem[] = [
  {
    label: "ARR達成率",
    value: 82,
    target: 100,
    max: 120,
    unit: "%",
    ranges: makeBands(40, 75, 120),
  },
  {
    label: "MQL",
    value: 450,
    target: 500,
    max: 600,
    unit: "件",
    ranges: makeBands(200, 400, 600),
  },
  {
    label: "SQLコンバート",
    value: 38,
    target: 50,
    max: 60,
    unit: "%",
    ranges: makeBands(15, 35, 60),
  },
];

interface BulletRowProps {
  item: BulletItem;
  barHeight: number;
  containerWidth: number;
}

function BulletRow({ item, barHeight, containerWidth }: BulletRowProps) {
  const { state: tooltipState, show, hide } = useTooltip();

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (containerWidth <= 0) return;

      const svgHeight = barHeight + 20;
      svg.attr("width", containerWidth).attr("height", svgHeight);

      const xScale = d3
        .scaleLinear()
        .domain([0, item.max])
        .range([0, containerWidth]);

      const g = svg.append("g").attr("transform", `translate(0,10)`);

      // ── Background qualitative bands ────────────────────────────
      const bands: Array<{ from: number; to: number; color: string; label?: string }> =
        item.ranges
          ? item.ranges.map((r) => ({ from: r.from, to: r.to, color: r.color, label: r.label }))
          : [
              { from: 0, to: item.max * 0.33, color: CHART_NEGATIVE },
              { from: item.max * 0.33, to: item.max * 0.66, color: CHART_WARNING },
              { from: item.max * 0.66, to: item.max, color: CHART_POSITIVE },
            ];

      for (const band of bands) {
        g.append("rect")
          .attr("x", xScale(band.from))
          .attr("y", 0)
          .attr("width", xScale(band.to) - xScale(band.from))
          .attr("height", barHeight)
          .attr("rx", 2)
          .attr("fill", band.color)
          // 淡い帯として敷く（元 CSS の pastel hex 相当）: var(...) を薄く。
          .attr("fill-opacity", 0.18);

        // Band border for clarity
        g.append("rect")
          .attr("x", xScale(band.from))
          .attr("y", 0)
          .attr("width", xScale(band.to) - xScale(band.from))
          .attr("height", barHeight)
          .attr("rx", 2)
          .attr("fill", "none")
          .attr("stroke", CHART_BORDER)
          .attr("stroke-opacity", 0.3)
          .attr("stroke-width", 0.5);
      }

      // ── Actual value bar (centered vertically, 50% height) ──────
      const valueWidth = xScale(Math.min(item.value, item.max));
      const actualBar = g
        .append("rect")
        .style("cursor", "pointer")
        .attr("x", 0)
        .attr("y", barHeight * 0.25)
        .attr("width", valueWidth)
        .attr("height", barHeight * 0.5)
        .attr("rx", 2)
        .attr("fill", getChartColor(0));

      // ── Target line — full height, prominent ─────────────────────
      const targetX = xScale(Math.min(item.target, item.max));
      g.append("rect")
        .attr("x", targetX - 2)
        .attr("y", -2)
        .attr("width", 4)
        .attr("height", barHeight + 4)
        .attr("rx", 2)
        .attr("fill", CHART_TEXT)
        .attr("pointer-events", "none");

      // Small triangle marker above the target line
      g.append("path")
        .attr("d", `M ${targetX - 4} -8 L ${targetX + 4} -8 L ${targetX} -2 Z`)
        .attr("fill", CHART_TEXT)
        .attr("pointer-events", "none");

      // ── Value label ──────────────────────────────────────────────
      const unit = item.unit ?? "";
      const pct = item.max > 0 ? Math.round((item.value / item.target) * 100) : 0;
      const labelText = `${formatNumber(item.value, 0)}${unit}`;
      const achieveText = `(目標比 ${pct}%)`;

      // Value text inside or just right of bar
      const textX = Math.min(valueWidth + 6, containerWidth - 60);
      g.append("text")
        .attr("x", textX)
        .attr("y", barHeight / 2)
        .attr("dominant-baseline", "middle")
        .attr("font-size", "11px")
        .attr("font-weight", "600")
        .attr("fill", CHART_TEXT)
        .text(labelText);

      // Achievement % — smaller, muted
      g.append("text")
        .attr("x", textX)
        .attr("y", barHeight / 2 + 11)
        .attr("dominant-baseline", "middle")
        .attr("font-size", "10px")
        .attr(
          "fill",
          pct >= 100 ? CHART_POSITIVE : pct >= 75 ? CHART_WARNING : CHART_NEGATIVE,
        )
        .text(achieveText);

      // ── Hover ────────────────────────────────────────────────────
      actualBar
        .on("mouseenter", function (event: MouseEvent) {
          d3.select(this).attr("opacity", 0.8);
          show(
            event,
            `${item.label}: ${formatNumber(item.value, 0)}${unit} / 目標 ${formatNumber(item.target, 0)}${unit} (${pct}%)`,
          );
        })
        .on("mouseleave", function () {
          d3.select(this).attr("opacity", 1);
          hide();
        });
    },
    [item, barHeight, containerWidth],
  );

  return (
    <div className="relative flex items-center gap-3">
      <div
        className="w-[120px] shrink-0 text-right text-[13px] leading-[1.4]"
        style={{ color: CHART_TEXT_MUTED }}
        aria-hidden="true"
      >
        {item.label}
      </div>
      <div className="relative min-w-0 flex-1">
        <svg
          ref={svgRef}
          className="block overflow-visible"
          role="img"
          aria-label={`${item.label}: ${item.value}`}
        />
        <ChartTooltip
          x={tooltipState.x}
          y={tooltipState.y}
          content={tooltipState.content}
          visible={tooltipState.visible}
        />
      </div>
    </div>
  );
}

export function BulletChart({
  items,
  width: propWidth,
  barHeight = 20,
  className,
  dataCategory,
}: BulletChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);

  const width = propWidth ?? observedWidth;
  // Subtract label width (120) + gap (12)
  const svgWidth = Math.max(0, width - 120 - 12);

  const resolvedItems =
    items ??
    (dataCategory ? ITEMS_BY_CATEGORY[dataCategory] : undefined) ??
    DEFAULT_ITEMS;

  return (
    <div
      ref={containerRef}
      className={cn("flex w-full flex-col gap-4 p-2", className)}
      role="list"
      aria-label="バレットチャート"
    >
      {resolvedItems.map((item) => (
        <BulletRow
          key={item.label}
          item={item}
          barHeight={barHeight}
          containerWidth={svgWidth}
        />
      ))}
    </div>
  );
}
