import { useRef } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { formatDate } from "../lib/formatters";
import { categoricalColor, semanticColor } from "../lib/chartRoles";
import {
  CHART_TEXT,
  CHART_TEXT_MUTED,
  CHART_BORDER,
} from "../lib/theme";
import { themeAxis } from "../lib/d3Theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export type TimelineMode = "gantt" | "milestone";

export interface TimelineEvent {
  id: string;
  label: string;
  start: Date;
  end?: Date;
  color?: string;
  row?: string;
  /** group name used for color-coding by resource */
  group?: string;
  /** completion percentage 0-100 */
  progress?: number;
}

export interface TimelineChartProps {
  data: TimelineEvent[];
  mode?: TimelineMode;
  showGrid?: boolean;
  showProgress?: boolean;
  showCurrentDate?: boolean;
  width?: number;
  height?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  className?: string;
}

const DEFAULT_TIMELINE_MARGIN = { top: 20, right: 20, bottom: 40, left: 130 };
const ROW_HEIGHT = 40;
const BAR_HEIGHT = 24;
const MILESTONE_SIZE = 8;

// Google-brand group colors → テーマ追従の chart パレットへ写像
const GROUP_ORDER: Record<string, number> = {
  設計: 0,
  開発: 3,
  QA: 2,
  リリース: 1,
};

function groupColor(group: string | undefined, fallbackIndex: number): string {
  // グループ = 真のカテゴリ → categoricalColor（テーマパレット循環）
  if (group && GROUP_ORDER[group] !== undefined) {
    return categoricalColor(GROUP_ORDER[group]!);
  }
  return categoricalColor(fallbackIndex);
}

export function TimelineChart({
  data,
  mode = "gantt",
  showGrid = true,
  showProgress = true,
  showCurrentDate = true,
  width: propWidth,
  height: propHeight,
  margin = DEFAULT_TIMELINE_MARGIN,
  className,
}: TimelineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { state: tooltipState, show, hide } = useTooltip();

  const width = propWidth ?? observedWidth;

  // Derive unique rows (swim lanes) in insertion order
  const uniqueRows = Array.from(
    new Map(data.map((d) => [d.row ?? d.label, true])).keys(),
  );

  const height =
    propHeight ?? uniqueRows.length * ROW_HEIGHT + margin.top + margin.bottom;

  const innerWidth = Math.max(0, width - margin.left - margin.right);
  const innerHeight = Math.max(0, height - margin.top - margin.bottom);

  // Time extent
  const allDates = data.flatMap((d) => [d.start, ...(d.end ? [d.end] : [])]);
  const timeExtent = d3.extent(allDates) as [Date, Date];

  // Pad domain slightly
  const paddedStart = new Date(timeExtent[0]);
  paddedStart.setDate(paddedStart.getDate() - 3);
  const paddedEnd = new Date(timeExtent[1]);
  paddedEnd.setDate(paddedEnd.getDate() + 3);

  const today = new Date();

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (data.length === 0 || innerWidth <= 0 || innerHeight <= 0) return;

      svg.attr("width", width).attr("height", height);

      const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      // Scales
      const xScale = d3
        .scaleTime()
        .domain([paddedStart, paddedEnd])
        .range([0, innerWidth]);

      const yScale = d3
        .scaleBand()
        .domain(uniqueRows)
        .range([0, innerHeight])
        .padding(0.2);

      // Grid lines (vertical, time-based)
      if (showGrid) {
        const ticks = xScale.ticks(6);
        g.selectAll(".grid-line")
          .data(ticks)
          .join("line")
          .attr("class", "grid-line")
          .attr("x1", (d) => xScale(d))
          .attr("x2", (d) => xScale(d))
          .attr("y1", 0)
          .attr("y2", innerHeight)
          .attr("stroke", CHART_BORDER)
          .attr("stroke-width", 1)
          .attr("stroke-dasharray", "3 3");
      }

      // X axis
      const xAxisG = g
        .append("g")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(
          d3
            .axisBottom(xScale)
            .ticks(6)
            .tickFormat((d) => {
              const date = d as Date;
              return date.toLocaleDateString("ja-JP", {
                month: "2-digit",
                day: "2-digit",
              });
            }),
        );
      themeAxis(xAxisG);

      // Row labels (left side, outside the chart area)
      g.selectAll<SVGTextElement, string>(".row-label")
        .data(uniqueRows)
        .join("text")
        .attr("class", "row-label")
        .attr("x", -8)
        .attr("y", (row) => (yScale(row) ?? 0) + yScale.bandwidth() / 2)
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "middle")
        .attr("font-size", "13px")
        .attr("fill", CHART_TEXT)
        .text((row) => row);

      if (mode === "gantt") {
        // Collect unique groups for legend
        const uniqueGroups = Array.from(
          new Set(data.map((d) => d.group).filter(Boolean)),
        ) as string[];

        data.forEach((event, i) => {
          if (!event.end) return;
          const rowKey = event.row ?? event.label;
          const x = xScale(event.start);
          const barW = Math.max(2, xScale(event.end) - xScale(event.start));
          const y = (yScale(rowKey) ?? 0) + (yScale.bandwidth() - BAR_HEIGHT) / 2;
          const color = event.color ?? groupColor(event.group, i);
          const progress = event.progress ?? 0;

          const barGroup = g
            .append("g")
            .attr("class", "bar-group")
            .style("cursor", "pointer");

          // Background bar (full width, lighter)
          barGroup
            .append("rect")
            .attr("x", x)
            .attr("y", y)
            .attr("width", barW)
            .attr("height", BAR_HEIGHT)
            .attr("rx", 3)
            .attr("fill", color)
            .attr("opacity", 0.25)
            .style("transition", "opacity 0.15s ease");

          // Progress bar (filled portion)
          if (showProgress && progress > 0) {
            const progressW = Math.max(2, barW * (progress / 100));
            barGroup
              .append("rect")
              .attr("x", x)
              .attr("y", y)
              .attr("width", progressW)
              .attr("height", BAR_HEIGHT)
              .attr("rx", 3)
              .attr("fill", color)
              .style("pointer-events", "none");

            // Progress % label if bar is wide enough
            if (barW > 50) {
              barGroup
                .append("text")
                .attr("x", x + barW - 4)
                .attr("y", y + BAR_HEIGHT / 2)
                .attr("text-anchor", "end")
                .attr("dominant-baseline", "middle")
                .attr("font-size", "11px")
                .attr("font-weight", 600)
                .attr("fill", "#ffffff")
                .style("pointer-events", "none")
                .text(`${progress}%`);
            }
          } else if (!showProgress) {
            // Solid bar when progress display is off
            barGroup
              .append("rect")
              .attr("x", x)
              .attr("y", y)
              .attr("width", barW)
              .attr("height", BAR_HEIGHT)
              .attr("rx", 3)
              .attr("fill", color);
          }

          // Label inside bar if space, outside if not
          const labelText = event.label;
          const estimatedTextWidth = labelText.length * 7;
          if (barW > estimatedTextWidth + 12) {
            barGroup
              .append("text")
              .attr("x", x + barW / 2)
              .attr("y", y + BAR_HEIGHT / 2)
              .attr("text-anchor", "middle")
              .attr("dominant-baseline", "middle")
              .attr("font-size", "11px")
              .attr("fill", "#ffffff")
              .style("pointer-events", "none")
              .text(labelText);
          } else {
            barGroup
              .append("text")
              .attr("x", x + barW + 4)
              .attr("y", y + BAR_HEIGHT / 2)
              .attr("text-anchor", "start")
              .attr("dominant-baseline", "middle")
              .attr("font-size", "11px")
              .attr("fill", CHART_TEXT_MUTED)
              .style("pointer-events", "none")
              .text(labelText);
          }

          // Transparent overlay for events
          barGroup
            .append("rect")
            .attr("x", x)
            .attr("y", y)
            .attr("width", barW)
            .attr("height", BAR_HEIGHT)
            .attr("rx", 3)
            .attr("fill", "transparent")
            .on("mouseenter", function (mouseEv: MouseEvent) {
              barGroup
                .selectAll("rect")
                .attr("opacity", (_, idx) => (idx === 0 ? 0.15 : 0.8));
              const progressText =
                showProgress && event.progress !== undefined
                  ? ` (${event.progress}%)`
                  : "";
              show(
                mouseEv,
                `${labelText}: ${formatDate(event.start)} 〜 ${
                  event.end ? formatDate(event.end) : ""
                }${progressText}`,
              );
            })
            .on("mouseleave", function () {
              barGroup.selectAll("rect").attr("opacity", null);
              hide();
            });
        });

        // Group legend (top right)
        if (uniqueGroups.length > 0) {
          const legendG = g.append("g").attr("class", "group-legend");
          const legendItemWidth = 80;
          const totalLegendWidth = uniqueGroups.length * legendItemWidth;
          const legendX = innerWidth - totalLegendWidth;

          uniqueGroups.forEach((grp, gi) => {
            const lx = legendX + gi * legendItemWidth;
            legendG
              .append("rect")
              .attr("x", lx)
              .attr("y", -16)
              .attr("width", 10)
              .attr("height", 10)
              .attr("rx", 2)
              .attr("fill", groupColor(grp, gi));
            legendG
              .append("text")
              .attr("x", lx + 14)
              .attr("y", -7)
              .attr("dominant-baseline", "middle")
              .attr("font-size", "11px")
              .attr("fill", CHART_TEXT_MUTED)
              .text(grp);
          });
        }
      } else {
        // Milestone mode: draw diamond shapes
        data.forEach((event, i) => {
          const rowKey = event.row ?? event.label;
          const cx = xScale(event.start);
          const cy = (yScale(rowKey) ?? 0) + yScale.bandwidth() / 2;
          const color = event.color ?? groupColor(event.group, i);
          const s = MILESTONE_SIZE;

          const milestoneGroup = g.append("g").attr("class", "milestone-group");

          // Diamond = rotated square via transform
          milestoneGroup
            .append("rect")
            .attr("x", cx - s)
            .attr("y", cy - s)
            .attr("width", s * 2)
            .attr("height", s * 2)
            .attr("transform", `rotate(45, ${cx}, ${cy})`)
            .attr("fill", color)
            .style("cursor", "pointer")
            .style("transition", "opacity 0.15s ease")
            .on("mouseenter", function (mouseEv: MouseEvent) {
              d3.select(this).attr("opacity", 0.8);
              show(mouseEv, `${event.label}: ${formatDate(event.start)}`);
            })
            .on("mouseleave", function () {
              d3.select(this).attr("opacity", 1);
              hide();
            });

          // Label below diamond
          milestoneGroup
            .append("text")
            .attr("x", cx)
            .attr("y", cy + s + 12)
            .attr("text-anchor", "middle")
            .attr("font-size", "11px")
            .attr("fill", CHART_TEXT_MUTED)
            .style("pointer-events", "none")
            .text(event.label);
        });
      }

      // Current date vertical line
      if (showCurrentDate && today >= paddedStart && today <= paddedEnd) {
        const todayX = xScale(today);
        const todayGroup = g.append("g").attr("class", "today-line");

        todayGroup
          .append("line")
          .attr("x1", todayX)
          .attr("x2", todayX)
          .attr("y1", -10)
          .attr("y2", innerHeight)
          .attr("stroke", semanticColor("negative"))
          .attr("stroke-width", 2)
          .attr("stroke-dasharray", "5 4");

        todayGroup
          .append("text")
          .attr("x", todayX)
          .attr("y", -14)
          .attr("text-anchor", "middle")
          .attr("font-size", "11px")
          .attr("font-weight", 600)
          .attr("fill", semanticColor("negative"))
          .text("今日");
      }
    },
    [
      data,
      width,
      height,
      innerWidth,
      innerHeight,
      mode,
      showGrid,
      showProgress,
      showCurrentDate,
      uniqueRows,
      paddedStart,
      paddedEnd,
      today,
    ],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
    >
      <svg
        ref={svgRef}
        className="block w-full overflow-visible"
        aria-label="タイムラインチャート"
        role="img"
      />
      <ChartTooltip
        x={tooltipState.x}
        y={tooltipState.y}
        content={tooltipState.content}
        visible={tooltipState.visible}
      />
    </div>
  );
}

export const TIMELINE_DEFAULT_DATA: TimelineEvent[] = [
  { id: "e1", label: "要件定義", start: new Date(2024, 0, 1), end: new Date(2024, 1, 15), group: "設計", row: "要件定義", progress: 100 },
  { id: "e2", label: "UI設計", start: new Date(2024, 1, 1), end: new Date(2024, 2, 31), group: "設計", row: "UI設計", progress: 100 },
  { id: "e3", label: "バックエンド開発", start: new Date(2024, 2, 1), end: new Date(2024, 5, 30), group: "開発", row: "バックエンド開発", progress: 80 },
  { id: "e4", label: "フロントエンド開発", start: new Date(2024, 2, 15), end: new Date(2024, 6, 15), group: "開発", row: "フロントエンド開発", progress: 65 },
  { id: "e5", label: "テスト", start: new Date(2024, 6, 1), end: new Date(2024, 7, 31), group: "QA", row: "テスト", progress: 20 },
  { id: "e6", label: "リリース", start: new Date(2024, 8, 1), end: new Date(2024, 8, 15), group: "リリース", row: "リリース", progress: 0 },
];
