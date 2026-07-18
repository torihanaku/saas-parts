import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { getInnerDimensions } from "../lib/d3Helpers";
import { formatNumber } from "../lib/formatters";
import { CHART_TEXT, CHART_TEXT_MUTED, CHART_BORDER, CHART_SURFACE } from "../lib/theme";
import { themeAxis } from "../lib/d3Theme";
import { SHAPE_RX } from "../lib/chartStyle";
import { categoricalColor } from "../lib/chartRoles";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export type HeatmapMode = "grid" | "calendar";

export interface HeatmapCell {
  row: string;
  col: string;
  value: number;
}

export interface CalendarCell {
  date: Date;
  value: number;
}

export interface HeatmapChartProps {
  data?: HeatmapCell[];
  calendarData?: CalendarCell[];
  rows?: string[];
  cols?: string[];
  mode?: HeatmapMode;
  colorScheme?: "blue" | "green" | "orange" | "purple" | "red" | string;
  showValues?: boolean;
  width?: number;
  height?: number;
  className?: string;
}

const DEFAULT_ROWS = ["月", "火", "水", "木", "金", "土", "日"];
const DEFAULT_COLS = ["9-11時", "11-13時", "13-15時", "15-17時", "17-19時"];

function generateDefaultData(rows: string[], cols: string[]): HeatmapCell[] {
  const cells: HeatmapCell[] = [];
  for (const row of rows) {
    for (const col of cols) {
      cells.push({ row, col, value: Math.round(Math.random() * 100) });
    }
  }
  return cells;
}

// Generate ~1 year of calendar data ending today
function generateCalendarData(): CalendarCell[] {
  const cells: CalendarCell[] = [];
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 1);
  start.setDate(start.getDate() + 1);
  const cur = new Date(start);
  while (cur <= end) {
    // weighted random: weekdays more active
    const dow = cur.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const base = isWeekend ? 2 : 5;
    const roll = Math.random();
    const value = roll < 0.3 ? 0 : Math.round(base + Math.random() * 15);
    cells.push({ date: new Date(cur), value });
    cur.setDate(cur.getDate() + 1);
  }
  return cells;
}

const GRID_MARGIN = { top: 24, right: 20, bottom: 48, left: 56 };
const CAL_MARGIN = { top: 28, right: 16, bottom: 8, left: 32 };

function getInterpolator(scheme: string | undefined) {
  if (scheme === "green") return d3.interpolateGreens;
  if (scheme === "orange") return d3.interpolateOranges;
  if (scheme === "purple") return d3.interpolatePurples;
  if (scheme === "red") return d3.interpolateReds;
  return d3.interpolateBlues;
}

// GitHub-style discrete green scale for calendar mode.
// 値ランプ(1〜4段)は「順序の階調」として妥当なので端点はこのまま維持する
// （d3.interpolate* 同様のシーケンシャル・ランプ扱い）。空(0)セルだけは
// テーマ追従の面色 CHART_SURFACE に寄せる（ハードコード #ebedf0 を撤去）。
const CAL_RAMP = ["#9be9a8", "#40c463", "#30a14e", "#216e39"] as const;
function calendarColorScale(value: number, maxVal: number): string {
  if (value === 0) return CHART_SURFACE;
  const ratio = value / maxVal;
  if (ratio < 0.25) return CAL_RAMP[0];
  if (ratio < 0.5) return CAL_RAMP[1];
  if (ratio < 0.75) return CAL_RAMP[2];
  return CAL_RAMP[3];
}

// Luminance-based contrast: returns white text for dark backgrounds, dark for light.
// 明るいセルには主テキスト色(CHART_TEXT)、暗いセルには白抜き(#fff は塗り上可読テキストの例外)。
function contrastColor(hexColor: string): string {
  const c = d3.color(hexColor);
  if (!c) return CHART_TEXT;
  const rgb = c.rgb();
  const toLinear = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const L =
    0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
  return L > 0.179 ? CHART_TEXT : "#ffffff";
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function HeatmapChart({
  data,
  calendarData,
  rows: rowsProp,
  cols: colsProp,
  mode = "grid",
  colorScheme = "green",
  showValues = false,
  width: propWidth,
  height = 320,
  className,
}: HeatmapChartProps) {
  const { show, hide, containerRef, tooltipRef } = useTooltip();
  const { width: observedWidth } = useResizeObserver(containerRef);

  const width = propWidth ?? observedWidth;

  // ── Grid mode data ──────────────────────────────────────────
  const resolvedRows = rowsProp ?? DEFAULT_ROWS;
  const resolvedCols = colsProp ?? DEFAULT_COLS;
  const resolvedData = data ?? generateDefaultData(resolvedRows, resolvedCols);

  // ── Calendar mode data ──────────────────────────────────────
  const resolvedCalData = calendarData ?? generateCalendarData();

  const gridDeps = [
    resolvedData,
    resolvedRows,
    resolvedCols,
    colorScheme,
    showValues,
    width,
    height,
  ];
  const calDeps = [resolvedCalData, colorScheme, width, height];

  // ── Grid SVG ────────────────────────────────────────────────
  const gridMargin = GRID_MARGIN;
  const { innerWidth: gridInnerW, innerHeight: gridInnerH } = getInnerDimensions(
    width,
    height,
    gridMargin,
  );

  const gridSvgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (mode !== "grid") return;
      if (gridInnerW <= 0 || gridInnerH <= 0) return;

      svg.attr("width", width).attr("height", height);

      const g = svg
        .append("g")
        .attr("transform", `translate(${gridMargin.left},${gridMargin.top})`);

      const xScale = d3
        .scaleBand()
        .domain(resolvedCols)
        .range([0, gridInnerW])
        .padding(0.05);

      const yScale = d3
        .scaleBand()
        .domain(resolvedRows)
        .range([0, gridInnerH])
        .padding(0.05);

      const minVal = d3.min(resolvedData, (d) => d.value) ?? 0;
      const maxVal = d3.max(resolvedData, (d) => d.value) ?? 1;

      const colorScaleFn = d3
        .scaleSequential(getInterpolator(colorScheme))
        .domain([minVal, maxVal]);

      // X axis (bottom) — 軸の着色は themeAxis に統一（オフセットのみ後付け）。
      const xAxisG = g
        .append("g")
        .attr("transform", `translate(0,${gridInnerH})`)
        .call(d3.axisBottom(xScale).tickSize(0))
        .call((axis) => axis.select(".domain").remove());
      themeAxis(xAxisG);
      xAxisG.selectAll("text").attr("dy", "1.2em");

      // Y axis (left)
      const yAxisG = g
        .append("g")
        .call(d3.axisLeft(yScale).tickSize(0))
        .call((axis) => axis.select(".domain").remove());
      themeAxis(yAxisG);
      yAxisG.selectAll("text").attr("dx", "-0.5em");

      // Cells
      const cells = g
        .selectAll<SVGRectElement, HeatmapCell>(".heatmap-cell")
        .data(resolvedData)
        .join("rect")
        .attr("class", "heatmap-cell")
        .style("cursor", "pointer")
        .attr("x", (d) => xScale(d.col) ?? 0)
        .attr("y", (d) => yScale(d.row) ?? 0)
        .attr("width", xScale.bandwidth())
        .attr("height", yScale.bandwidth())
        .attr("rx", SHAPE_RX)
        // 値スケール（連続カラーランプ）は flat 例外：fillFor（縦グラデ）は使わず
        // d3.scaleSequential のロール色をそのまま塗る。
        .attr("fill", (d) => colorScaleFn(d.value))
        .attr("stroke", "none")
        .attr("stroke-width", 2);

      cells
        .on("mouseenter", function (event: MouseEvent, d) {
          d3.select(this)
            .raise()
            .attr("stroke", categoricalColor(0))
            .attr("stroke-width", 2);
          show(event, `${d.row} ${d.col}: ${formatNumber(d.value, 0)}`);
        })
        .on("mouseleave", function () {
          d3.select(this).attr("stroke", "none");
          hide();
        });

      // Value labels
      if (showValues) {
        g.selectAll<SVGTextElement, HeatmapCell>(".heatmap-label")
          .data(resolvedData)
          .join("text")
          .attr("class", "heatmap-label")
          .attr("x", (d) => (xScale(d.col) ?? 0) + xScale.bandwidth() / 2)
          .attr("y", (d) => (yScale(d.row) ?? 0) + yScale.bandwidth() / 2)
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "middle")
          .attr("font-size", "11px")
          .attr("pointer-events", "none")
          .attr("fill", (d) => contrastColor(colorScaleFn(d.value)))
          .text((d) => formatNumber(d.value, 0));
      }
    },
    [...gridDeps, mode, gridInnerW, gridInnerH],
  );

  // ── Calendar SVG ────────────────────────────────────────────
  // Layout: Sun=row 0, Sat=row 6. Columns = weeks.
  // We render a full year: from the Sunday on/before (today - 1 year) to today.
  const calSvgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (mode !== "calendar") return;
      if (width <= 0) return;

      // Build date→value map
      const dateMap = new Map<string, number>();
      for (const c of resolvedCalData) {
        const key = d3.timeFormat("%Y-%m-%d")(c.date);
        dateMap.set(key, c.value);
      }

      const maxVal = d3.max(resolvedCalData, (d) => d.value) ?? 1;

      // Determine date range: last 53 weeks ending on last Saturday >= today
      const today = new Date();
      // align end to Saturday (day 6)
      const end = new Date(today);
      end.setDate(end.getDate() + (6 - end.getDay()));
      // start: 52 weeks back, on Sunday
      const start = new Date(end);
      start.setDate(start.getDate() - 52 * 7 - 6); // 53 weeks of Sundays
      // snap to Sunday
      start.setDate(start.getDate() - start.getDay());

      // Build weeks array
      const weeks: Date[][] = [];
      const cur = new Date(start);
      while (cur <= end) {
        const week: Date[] = [];
        for (let dow = 0; dow < 7; dow++) {
          week.push(new Date(cur));
          cur.setDate(cur.getDate() + 1);
        }
        weeks.push(week);
      }

      const numWeeks = weeks.length;
      const CELL = Math.max(
        10,
        Math.min(
          14,
          Math.floor((width - CAL_MARGIN.left - CAL_MARGIN.right) / numWeeks) - 2,
        ),
      );
      const GAP = 2;
      const STEP = CELL + GAP;
      const calHeight = 7 * STEP + CAL_MARGIN.top + CAL_MARGIN.bottom;

      svg.attr("width", width).attr("height", calHeight);

      const g = svg
        .append("g")
        .attr("transform", `translate(${CAL_MARGIN.left},${CAL_MARGIN.top})`);

      // Day-of-week labels (Mon, Wed, Fri)
      [1, 3, 5].forEach((dow) => {
        g.append("text")
          .attr("x", -4)
          .attr("y", dow * STEP + CELL / 2)
          .attr("text-anchor", "end")
          .attr("dominant-baseline", "middle")
          .attr("font-size", 9)
          .attr("fill", CHART_TEXT_MUTED)
          .text(DOW_LABELS[dow]!);
      });

      // Month labels
      const monthSeen = new Set<string>();
      weeks.forEach((week, wi) => {
        const firstDay = week[0]!; // Sunday
        const monthKey = d3.timeFormat("%Y-%m")(firstDay);
        if (!monthSeen.has(monthKey)) {
          monthSeen.add(monthKey);
          const monthIdx = firstDay.getMonth();
          g.append("text")
            .attr("x", wi * STEP)
            .attr("y", -8)
            .attr("font-size", 9)
            .attr("fill", CHART_TEXT_MUTED)
            .text(MONTH_LABELS[monthIdx]!);
        }
      });

      // Cells
      weeks.forEach((week, wi) => {
        week.forEach((date, dow) => {
          const key = d3.timeFormat("%Y-%m-%d")(date);
          const value = dateMap.get(key) ?? 0;
          const isFuture = date > today;

          const rect = g
            .append("rect")
            .attr("x", wi * STEP)
            .attr("y", dow * STEP)
            .attr("width", CELL)
            .attr("height", CELL)
            .attr("rx", SHAPE_RX)
            // 値ランプ（GitHub 風の階調）も連続カラーランプの flat 例外。
            .attr("fill", isFuture ? CHART_BORDER : calendarColorScale(value, maxVal))
            .style("cursor", "pointer");

          rect
            .on("mouseenter", function (event: MouseEvent) {
              d3.select(this).attr("stroke", CHART_TEXT_MUTED).attr("stroke-width", 1.5);
              const fmt = d3.timeFormat("%Y年%-m月%-d日");
              show(event, `${fmt(date)}: ${value} 件`);
            })
            .on("mouseleave", function () {
              d3.select(this).attr("stroke", "none");
              hide();
            });
        });
      });

      // Legend (bottom right)
      const legendX = (numWeeks - 6) * STEP;
      const legendY = 7 * STEP + 4;
      // 凡例: 空セル(CHART_SURFACE)＋値ランプ4段（calendarColorScale と同一階調）。
      const legendColors = [CHART_SURFACE, ...CAL_RAMP];
      g.append("text")
        .attr("x", legendX - 6)
        .attr("y", legendY + CELL / 2)
        .attr("text-anchor", "end")
        .attr("dominant-baseline", "middle")
        .attr("font-size", 9)
        .attr("fill", CHART_TEXT_MUTED)
        .text("少");
      legendColors.forEach((color, i) => {
        g.append("rect")
          .attr("x", legendX + i * STEP)
          .attr("y", legendY)
          .attr("width", CELL)
          .attr("height", CELL)
          .attr("rx", SHAPE_RX)
          .attr("fill", color);
      });
      g.append("text")
        .attr("x", legendX + legendColors.length * STEP + 4)
        .attr("y", legendY + CELL / 2)
        .attr("dominant-baseline", "middle")
        .attr("font-size", 9)
        .attr("fill", CHART_TEXT_MUTED)
        .text("多");
    },
    [...calDeps, mode],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full overflow-hidden", className)}
      role="img"
      aria-label="ヒートマップチャート"
    >
      {mode === "grid" ? (
        <svg ref={gridSvgRef} />
      ) : (
        <svg ref={calSvgRef} style={{ overflow: "visible" }} />
      )}
      <ChartTooltip ref={tooltipRef} />
    </div>
  );
}
