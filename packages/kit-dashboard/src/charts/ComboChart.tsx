import { useRef } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { getInnerDimensions } from "../lib/d3Helpers";
import { getColorScheme, getChartColor } from "../lib/colorUtils";
import { formatNumber } from "../lib/formatters";
import {
  CHART_TEXT_MUTED,
  CHART_SURFACE,
  CHART_NEGATIVE,
} from "../lib/theme";
import { themeAxis, themeGrid } from "../lib/d3Theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface ComboDataPoint {
  label: string;
  barValue: number;
  lineValue: number;
  barValue2?: number;
}

export interface ComboChartProps {
  data?: ComboDataPoint[];
  barLabel?: string;
  lineLabel?: string;
  bar2Label?: string;
  barVariant?: "single" | "grouped" | "stacked";
  lineSmooth?: boolean;
  showGrid?: boolean;
  showLegend?: boolean;
  animated?: boolean;
  width?: number;
  height?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  className?: string;
  colorScheme?: string;
  showSecondaryAxis?: boolean; // show right Y-axis for line (CVR %)
}

const DEFAULT_DATA: ComboDataPoint[] = [
  { label: "1月", barValue: 320, lineValue: 12.5 },
  { label: "2月", barValue: 380, lineValue: 14.2 },
  { label: "3月", barValue: 410, lineValue: 13.8 },
  { label: "4月", barValue: 360, lineValue: 15.1 },
  { label: "5月", barValue: 450, lineValue: 16.4 },
  { label: "6月", barValue: 490, lineValue: 17.0 },
];

const DEFAULT_MARGIN = { top: 20, right: 60, bottom: 40, left: 50 };

// 主系列バー=chart-1、副系列バー=chart-3、ライン=negative（元 Google Red 相当）
const DEFAULT_COLOR_BAR_PRIMARY = getChartColor(0);
const DEFAULT_COLOR_BAR_SECONDARY = getChartColor(2);
const DEFAULT_COLOR_LINE = CHART_NEGATIVE;

export function ComboChart({
  data = DEFAULT_DATA,
  barLabel = "リード数",
  lineLabel = "CVR%",
  bar2Label = "リード数2",
  barVariant = "single",
  lineSmooth = false,
  showGrid = true,
  showLegend = true,
  animated = true,
  width: propWidth,
  height = 320,
  margin = DEFAULT_MARGIN,
  className,
  colorScheme,
  showSecondaryAxis = true,
}: ComboChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { state: tooltipState, show, hide } = useTooltip();

  const width = propWidth ?? observedWidth;
  const { innerWidth, innerHeight } = getInnerDimensions(width, height, margin);

  const hasBar2 =
    barVariant !== "single" && data.some((d) => d.barValue2 != null);

  // Apply colorScheme override if provided; fall back to token-based defaults
  const schemeColors = colorScheme ? getColorScheme(colorScheme) : null;
  const colorBarPrimary = schemeColors?.[0] ?? DEFAULT_COLOR_BAR_PRIMARY;
  const colorBarSecondary = schemeColors?.[1] ?? DEFAULT_COLOR_BAR_SECONDARY;
  const colorLine = schemeColors?.[2] ?? DEFAULT_COLOR_LINE;

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (!data.length || innerWidth <= 0 || innerHeight <= 0) return;

      svg.attr("width", width).attr("height", height);

      const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      // --- X (band) scale for categories ---
      const xScale = d3
        .scaleBand()
        .domain(data.map((d) => d.label))
        .range([0, innerWidth])
        .padding(0.25);

      // --- Left Y scale for bar values ---
      let barMaxVal: number;
      if (barVariant === "stacked" && hasBar2) {
        barMaxVal = d3.max(data, (d) => d.barValue + (d.barValue2 ?? 0)) ?? 0;
      } else {
        barMaxVal =
          d3.max(data, (d) => Math.max(d.barValue, d.barValue2 ?? 0)) ?? 0;
      }

      const yLeft = d3
        .scaleLinear()
        .domain([0, barMaxVal])
        .nice()
        .range([innerHeight, 0]);

      // --- Right Y scale for line values ---
      const lineMin = d3.min(data, (d) => d.lineValue) ?? 0;
      const lineMax = d3.max(data, (d) => d.lineValue) ?? 0;
      const linePad = (lineMax - lineMin) * 0.15 || 1;

      const yRight = d3
        .scaleLinear()
        .domain([Math.max(0, lineMin - linePad), lineMax + linePad])
        .nice()
        .range([innerHeight, 0]);

      // --- Grid lines (left axis ticks only) ---
      if (showGrid) {
        const gridG = g
          .append("g")
          .call(
            d3
              .axisLeft(yLeft)
              .tickSize(-innerWidth)
              .tickFormat(() => ""),
          );
        themeGrid(gridG);
      }

      // --- X axis ---
      const xAxisG = g
        .append("g")
        .attr("transform", `translate(0,${innerHeight})`)
        .call(d3.axisBottom(xScale));
      themeAxis(xAxisG);

      // --- Left Y axis ---
      const yLeftAxisG = g
        .append("g")
        .call(
          d3.axisLeft(yLeft).tickFormat((d) => formatNumber(d as number, 0)),
        );
      themeAxis(yLeftAxisG);

      // Left axis label "件数"
      g.append("text")
        .attr("transform", "rotate(-90)")
        .attr("x", -innerHeight / 2)
        .attr("y", -margin.left + 12)
        .attr("text-anchor", "middle")
        .attr("font-size", "11px")
        .attr("fill", CHART_TEXT_MUTED)
        .text("件数");

      // --- Right Y axis ---
      if (showSecondaryAxis) {
        const yRightAxisG = g
          .append("g")
          .attr("transform", `translate(${innerWidth},0)`)
          .call(
            d3.axisRight(yRight).tickFormat((d) => `${(d as number).toFixed(1)}%`),
          );
        themeAxis(yRightAxisG);

        // Right axis label "CVR (%)"
        g.append("text")
          .attr("transform", "rotate(90)")
          .attr("x", innerHeight / 2)
          .attr("y", -(innerWidth + margin.right - 12))
          .attr("text-anchor", "middle")
          .attr("font-size", "11px")
          .attr("fill", CHART_TEXT_MUTED)
          .text("CVR (%)");
      }

      // =============================================
      // BAR SERIES
      // =============================================

      if (barVariant === "grouped" && hasBar2) {
        // Sub-band scale for two bars side by side
        const subScale = d3
          .scaleBand()
          .domain(["primary", "secondary"])
          .range([0, xScale.bandwidth()])
          .padding(0.05);

        // Primary bars
        const primaryBars = g
          .selectAll<SVGRectElement, ComboDataPoint>(".bar-primary")
          .data(data)
          .join("rect")
          .attr("class", "bar-primary")
          .style("cursor", "pointer")
          .attr("x", (d) => (xScale(d.label) ?? 0) + (subScale("primary") ?? 0))
          .attr("width", subScale.bandwidth())
          .attr("rx", 2)
          .attr("fill", colorBarPrimary)
          .attr("y", innerHeight)
          .attr("height", 0);

        // Secondary bars
        const secondaryBars = g
          .selectAll<SVGRectElement, ComboDataPoint>(".bar-secondary")
          .data(data)
          .join("rect")
          .attr("class", "bar-secondary")
          .style("cursor", "pointer")
          .attr(
            "x",
            (d) => (xScale(d.label) ?? 0) + (subScale("secondary") ?? 0),
          )
          .attr("width", subScale.bandwidth())
          .attr("rx", 2)
          .attr("fill", colorBarSecondary)
          .attr("y", innerHeight)
          .attr("height", 0);

        if (animated) {
          primaryBars
            .transition()
            .duration(600)
            .ease(d3.easeCubicOut)
            .attr("y", (d) => yLeft(d.barValue))
            .attr("height", (d) => innerHeight - yLeft(d.barValue));

          secondaryBars
            .transition()
            .duration(600)
            .ease(d3.easeCubicOut)
            .attr("y", (d) => yLeft(d.barValue2 ?? 0))
            .attr("height", (d) => innerHeight - yLeft(d.barValue2 ?? 0));
        } else {
          primaryBars
            .attr("y", (d) => yLeft(d.barValue))
            .attr("height", (d) => innerHeight - yLeft(d.barValue));

          secondaryBars
            .attr("y", (d) => yLeft(d.barValue2 ?? 0))
            .attr("height", (d) => innerHeight - yLeft(d.barValue2 ?? 0));
        }

        // Hover overlays for grouped
        g.selectAll<SVGRectElement, ComboDataPoint>(".bar-hover-grouped")
          .data(data)
          .join("rect")
          .attr("class", "bar-hover-grouped")
          .attr("x", (d) => xScale(d.label) ?? 0)
          .attr("width", xScale.bandwidth())
          .attr("y", 0)
          .attr("height", innerHeight)
          .attr("fill", "transparent")
          .on("mouseenter", function (event: MouseEvent, d) {
            show(
              event,
              `${d.label}  ${barLabel}: ${formatNumber(d.barValue, 0)}  ${bar2Label}: ${formatNumber(d.barValue2 ?? 0, 0)}  ${lineLabel}: ${d.lineValue.toFixed(1)}%`,
            );
          })
          .on("mouseleave", () => hide());
      } else if (barVariant === "stacked" && hasBar2) {
        // Stacked bars: render primary first (bottom), then secondary on top
        const primaryBars = g
          .selectAll<SVGRectElement, ComboDataPoint>(".bar-primary")
          .data(data)
          .join("rect")
          .attr("class", "bar-primary")
          .style("cursor", "pointer")
          .attr("x", (d) => xScale(d.label) ?? 0)
          .attr("width", xScale.bandwidth())
          .attr("rx", 2)
          .attr("fill", colorBarPrimary)
          .attr("y", innerHeight)
          .attr("height", 0);

        const secondaryBars = g
          .selectAll<SVGRectElement, ComboDataPoint>(".bar-secondary")
          .data(data)
          .join("rect")
          .attr("class", "bar-secondary")
          .style("cursor", "pointer")
          .attr("x", (d) => xScale(d.label) ?? 0)
          .attr("width", xScale.bandwidth())
          .attr("rx", 0)
          .attr("fill", colorBarSecondary)
          .attr("y", innerHeight)
          .attr("height", 0);

        if (animated) {
          primaryBars
            .transition()
            .duration(600)
            .ease(d3.easeCubicOut)
            .attr("y", (d) => yLeft(d.barValue))
            .attr("height", (d) => innerHeight - yLeft(d.barValue));

          secondaryBars
            .transition()
            .duration(600)
            .ease(d3.easeCubicOut)
            .attr("y", (d) => yLeft(d.barValue + (d.barValue2 ?? 0)))
            .attr("height", (d) => innerHeight - yLeft(d.barValue2 ?? 0));
        } else {
          primaryBars
            .attr("y", (d) => yLeft(d.barValue))
            .attr("height", (d) => innerHeight - yLeft(d.barValue));

          secondaryBars
            .attr("y", (d) => yLeft(d.barValue + (d.barValue2 ?? 0)))
            .attr("height", (d) => innerHeight - yLeft(d.barValue2 ?? 0));
        }

        // Hover overlays for stacked
        g.selectAll<SVGRectElement, ComboDataPoint>(".bar-hover-stacked")
          .data(data)
          .join("rect")
          .attr("class", "bar-hover-stacked")
          .attr("x", (d) => xScale(d.label) ?? 0)
          .attr("width", xScale.bandwidth())
          .attr("y", 0)
          .attr("height", innerHeight)
          .attr("fill", "transparent")
          .on("mouseenter", function (event: MouseEvent, d) {
            show(
              event,
              `${d.label}  ${barLabel}: ${formatNumber(d.barValue, 0)}  ${bar2Label}: ${formatNumber(d.barValue2 ?? 0, 0)}  ${lineLabel}: ${d.lineValue.toFixed(1)}%`,
            );
          })
          .on("mouseleave", () => hide());
      } else {
        // Single bar series
        const bars = g
          .selectAll<SVGRectElement, ComboDataPoint>(".bar-single")
          .data(data)
          .join("rect")
          .attr("class", "bar-single")
          .style("cursor", "pointer")
          .attr("x", (d) => xScale(d.label) ?? 0)
          .attr("width", xScale.bandwidth())
          .attr("rx", 2)
          .attr("fill", colorBarPrimary)
          .attr("y", innerHeight)
          .attr("height", 0);

        if (animated) {
          bars
            .transition()
            .duration(600)
            .ease(d3.easeCubicOut)
            .attr("y", (d) => yLeft(d.barValue))
            .attr("height", (d) => innerHeight - yLeft(d.barValue));
        } else {
          bars
            .attr("y", (d) => yLeft(d.barValue))
            .attr("height", (d) => innerHeight - yLeft(d.barValue));
        }

        bars
          .on("mouseenter", function (event: MouseEvent, d) {
            d3.select(this).attr("opacity", 0.8);
            show(
              event,
              `${d.label}  ${barLabel}: ${formatNumber(d.barValue, 0)}  ${lineLabel}: ${d.lineValue.toFixed(1)}%`,
            );
          })
          .on("mouseleave", function () {
            d3.select(this).attr("opacity", 1);
            hide();
          });
      }

      // =============================================
      // LINE SERIES
      // =============================================

      const curve = lineSmooth
        ? d3.curveCatmullRom.alpha(0.5)
        : d3.curveLinear;

      const lineGenerator = d3
        .line<ComboDataPoint>()
        .x((d) => (xScale(d.label) ?? 0) + xScale.bandwidth() / 2)
        .y((d) => yRight(d.lineValue))
        .curve(curve);

      const linePath = g
        .append("path")
        .datum(data)
        .style("pointer-events", "none")
        .attr("fill", "none")
        .attr("stroke", colorLine)
        .attr("stroke-width", 2)
        .attr("d", lineGenerator);

      // Stroke-dasharray animation: draw line from left to right
      if (animated) {
        const totalLength =
          (linePath.node() as SVGPathElement | null)?.getTotalLength() ?? 0;
        linePath
          .attr("stroke-dasharray", `${totalLength} ${totalLength}`)
          .attr("stroke-dashoffset", totalLength)
          .transition()
          .duration(800)
          .ease(d3.easeLinear)
          .attr("stroke-dashoffset", 0);
      }

      // Dots on line
      const dots = g
        .selectAll<SVGCircleElement, ComboDataPoint>(".line-dot")
        .data(data)
        .join("circle")
        .attr("class", "line-dot")
        .style("cursor", "pointer")
        .attr("cx", (d) => (xScale(d.label) ?? 0) + xScale.bandwidth() / 2)
        .attr("cy", (d) => yRight(d.lineValue))
        .attr("r", 4)
        .attr("fill", colorLine)
        .attr("stroke", CHART_SURFACE)
        .attr("stroke-width", 1.5);

      if (animated) {
        dots
          .attr("opacity", 0)
          .transition()
          .delay(700)
          .duration(200)
          .attr("opacity", 1);
      }

      // Dot hover events
      dots
        .on("mouseenter", function (event: MouseEvent, d) {
          d3.select(this).attr("r", 6);
          show(event, `${d.label}  ${lineLabel}: ${d.lineValue.toFixed(1)}%`);
        })
        .on("mouseleave", function () {
          d3.select(this).attr("r", 4);
          hide();
        });
    },
    [
      data,
      width,
      height,
      barVariant,
      lineSmooth,
      showGrid,
      animated,
      innerWidth,
      innerHeight,
      barLabel,
      lineLabel,
      bar2Label,
      colorBarPrimary,
      colorBarSecondary,
      colorLine,
      showSecondaryAxis,
    ],
  );

  // Build legend items
  const legendItems: { color: string; label: string; isLine?: boolean }[] = [
    { color: colorBarPrimary, label: barLabel ?? "バー" },
  ];
  if (hasBar2 && (barVariant as string) !== "single") {
    legendItems.push({ color: colorBarSecondary, label: bar2Label ?? "バー2" });
  }
  legendItems.push({ color: colorLine, label: lineLabel ?? "ライン", isLine: true });

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full overflow-hidden", className)}
    >
      <svg ref={svgRef} />
      {showLegend && (
        <div className="flex flex-wrap gap-4 pt-2">
          {legendItems.map((item) => (
            <div
              key={item.label}
              className="flex items-center gap-1 text-[11px]"
              style={{ color: CHART_TEXT_MUTED }}
            >
              {item.isLine ? (
                <svg
                  width="16"
                  height="10"
                  className="block shrink-0"
                  aria-hidden="true"
                >
                  <line
                    x1="0"
                    y1="5"
                    x2="16"
                    y2="5"
                    stroke={item.color}
                    strokeWidth="2"
                  />
                  <circle cx="8" cy="5" r="3" fill={item.color} />
                </svg>
              ) : (
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: item.color }}
                  aria-hidden="true"
                />
              )}
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      )}
      <ChartTooltip
        x={tooltipState.x}
        y={tooltipState.y}
        content={tooltipState.content}
        visible={tooltipState.visible}
      />
    </div>
  );
}
