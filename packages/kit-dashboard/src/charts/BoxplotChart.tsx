import { useRef } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { getInnerDimensions } from "../lib/d3Helpers";
import { categoricalColor } from "../lib/chartRoles";
import { fillFor, SHAPE_RX } from "../lib/chartStyle";
import { themeAxis, themeGrid } from "../lib/d3Theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface BoxplotSeries {
  label: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  outliers?: number[];
  color?: string;
}

export type BoxplotColorScheme = "blue" | "green" | "orange" | "purple" | "red";

export interface BoxplotChartProps {
  data?: BoxplotSeries[];
  width?: number;
  height?: number;
  colorScheme?: BoxplotColorScheme;
  orientation?: "vertical" | "horizontal";
  animated?: boolean;
  className?: string;
}

const DEFAULT_DATA: BoxplotSeries[] = [
  { label: "Q1", min: 20, q1: 45, median: 65, q3: 80, max: 110, outliers: [5, 125] },
  { label: "Q2", min: 30, q1: 55, median: 75, q3: 90, max: 120 },
  { label: "Q3", min: 25, q1: 50, median: 70, q3: 88, max: 115, outliers: [10, 130] },
  { label: "Q4", min: 40, q1: 65, median: 85, q3: 98, max: 130 },
];

// 各カラースキームをチャートパレット（CSS 変数）のインデックスに写像する。
// 実体色ではなく var(--chart-N) 文字列を返すのでダークモードに追従する。
const SCHEME_INDEX: Record<BoxplotColorScheme, number> = {
  blue: 0,
  green: 3,
  orange: 4,
  purple: 6,
  red: 1,
};

const MARGIN = { top: 20, right: 20, bottom: 40, left: 50 };

export function BoxplotChart({
  data,
  width: propWidth,
  height = 320,
  colorScheme = "blue",
  orientation = "vertical",
  animated = true,
  className,
}: BoxplotChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { show, hide, tooltipRef } = useTooltip();

  const resolvedData = data ?? DEFAULT_DATA;
  const width = propWidth ?? observedWidth;
  const { innerWidth, innerHeight } = getInnerDimensions(width, height, MARGIN);

  // 単一系列の箱ひげはユーザーが選んだ1つの hue で全カテゴリを統一（虹色にしない）。
  // colorScheme は明示選択の配色なので categoricalColor でその hue を引く。
  const mainColor = categoricalColor(SCHEME_INDEX[colorScheme]);

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (innerWidth <= 0 || innerHeight <= 0 || resolvedData.length === 0) return;

      svg.attr("width", width).attr("height", height);

      const g = svg
        .append("g")
        .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

      // 箱のベタ塗り回避: 共通の標準塗り(fillFor)を色ごとに1度だけ生成してキャッシュする。
      const defs = svg.append("defs");
      const tintCache = new Map<string, string>();
      const boxTint = (color: string): string => {
        let url = tintCache.get(color);
        if (!url) {
          url = fillFor(defs, color);
          tintCache.set(color, url);
        }
        return url;
      };

      // Collect all values including outliers for domain calculation
      const allValues: number[] = [];
      resolvedData.forEach((d) => {
        allValues.push(d.min, d.max);
        if (d.outliers) allValues.push(...d.outliers);
      });
      const [domainMin, domainMax] = d3.extent(allValues) as [number, number];
      const padding = (domainMax - domainMin) * 0.08;

      if (orientation === "vertical") {
        // Vertical: category on X, value on Y
        const xScale = d3
          .scaleBand()
          .domain(resolvedData.map((d) => d.label))
          .range([0, innerWidth])
          .padding(0.35);

        const yScale = d3
          .scaleLinear()
          .domain([domainMin - padding, domainMax + padding])
          .nice()
          .range([innerHeight, 0]);

        // Grid lines
        const gridG = g
          .append("g")
          .call(
            d3
              .axisLeft(yScale)
              .tickSize(-innerWidth)
              .tickFormat(() => ""),
          );
        themeGrid(gridG);

        // X axis
        const xAxisG = g
          .append("g")
          .attr("transform", `translate(0,${innerHeight})`)
          .call(d3.axisBottom(xScale));
        themeAxis(xAxisG);

        // Y axis
        const yAxisG = g.append("g").call(d3.axisLeft(yScale).ticks(5));
        themeAxis(yAxisG);

        const boxWidth = xScale.bandwidth();

        resolvedData.forEach((d, i) => {
          const x = xScale(d.label) ?? 0;
          const cx = x + boxWidth / 2;
          const seriesColor = d.color ?? mainColor;

          // Whisker — lower (Q1 to min)
          const whiskerLower = g
            .append("line")
            .attr("x1", cx)
            .attr("x2", cx)
            .attr("stroke", seriesColor)
            .attr("stroke-width", 1.5);

          // Whisker — upper (Q3 to max)
          const whiskerUpper = g
            .append("line")
            .attr("x1", cx)
            .attr("x2", cx)
            .attr("stroke", seriesColor)
            .attr("stroke-width", 1.5);

          // Whisker cap — lower
          const capLower = g
            .append("line")
            .attr("x1", x + boxWidth * 0.25)
            .attr("x2", x + boxWidth * 0.75)
            .attr("stroke", seriesColor)
            .attr("stroke-width", 1.5);

          // Whisker cap — upper
          const capUpper = g
            .append("line")
            .attr("x1", x + boxWidth * 0.25)
            .attr("x2", x + boxWidth * 0.75)
            .attr("stroke", seriesColor)
            .attr("stroke-width", 1.5);

          // Box (Q1 to Q3) — tint グラデで深みを出す（ベタ塗り回避）。
          const box = g
            .append("rect")
            .attr("class", "bp-box")
            .style("cursor", "pointer")
            .attr("x", x)
            .attr("width", boxWidth)
            .attr("rx", SHAPE_RX)
            .attr("fill", boxTint(seriesColor))
            .attr("stroke", seriesColor)
            .attr("stroke-width", 1.5);

          // Median line
          const medianLine = g
            .append("line")
            .attr("x1", x)
            .attr("x2", x + boxWidth)
            .attr("stroke", seriesColor)
            .attr("stroke-width", 2)
            .attr("stroke-opacity", 0.9);

          if (animated) {
            const delay = i * 80;

            whiskerLower
              .attr("y1", yScale(d.q1))
              .attr("y2", yScale(d.q1))
              .transition()
              .duration(500)
              .delay(delay)
              .attr("y1", yScale(d.q1))
              .attr("y2", yScale(d.min));

            whiskerUpper
              .attr("y1", yScale(d.q3))
              .attr("y2", yScale(d.q3))
              .transition()
              .duration(500)
              .delay(delay)
              .attr("y1", yScale(d.q3))
              .attr("y2", yScale(d.max));

            capLower
              .attr("y1", yScale(d.q1))
              .attr("y2", yScale(d.q1))
              .transition()
              .duration(500)
              .delay(delay)
              .attr("y1", yScale(d.min))
              .attr("y2", yScale(d.min));

            capUpper
              .attr("y1", yScale(d.q3))
              .attr("y2", yScale(d.q3))
              .transition()
              .duration(500)
              .delay(delay)
              .attr("y1", yScale(d.max))
              .attr("y2", yScale(d.max));

            box
              .attr("y", yScale(d.q1))
              .attr("height", 0)
              .transition()
              .duration(500)
              .delay(delay)
              .attr("y", yScale(d.q3))
              .attr("height", yScale(d.q1) - yScale(d.q3));

            medianLine
              .attr("y1", yScale(d.q1))
              .attr("y2", yScale(d.q1))
              .transition()
              .duration(500)
              .delay(delay)
              .attr("y1", yScale(d.median))
              .attr("y2", yScale(d.median));
          } else {
            whiskerLower.attr("y1", yScale(d.q1)).attr("y2", yScale(d.min));
            whiskerUpper.attr("y1", yScale(d.q3)).attr("y2", yScale(d.max));
            capLower.attr("y1", yScale(d.min)).attr("y2", yScale(d.min));
            capUpper.attr("y1", yScale(d.max)).attr("y2", yScale(d.max));
            box.attr("y", yScale(d.q3)).attr("height", yScale(d.q1) - yScale(d.q3));
            medianLine.attr("y1", yScale(d.median)).attr("y2", yScale(d.median));
          }

          // Outlier dots
          if (d.outliers && d.outliers.length > 0) {
            d.outliers.forEach((outlierVal) => {
              const dot = g
                .append("circle")
                .style("cursor", "pointer")
                .attr("cx", cx)
                .attr("r", 4)
                .attr("fill", "none")
                .attr("stroke", seriesColor)
                .attr("stroke-width", 1.5);

              if (animated) {
                dot
                  .attr("cy", yScale(d.median))
                  .attr("opacity", 0)
                  .transition()
                  .duration(400)
                  .delay(i * 80 + 300)
                  .attr("cy", yScale(outlierVal))
                  .attr("opacity", 1);
              } else {
                dot.attr("cy", yScale(outlierVal));
              }

              dot
                .on("mouseenter", function (event: MouseEvent) {
                  d3.select(this).attr("r", 6);
                  show(event, `外れ値: ${outlierVal}`);
                })
                .on("mouseleave", function () {
                  d3.select(this).attr("r", 4);
                  hide();
                });
            });
          }

          // Invisible hover area over box for tooltip
          g.append("rect")
            .attr("x", x)
            .attr("y", Math.min(yScale(d.max), yScale(d.min)))
            .attr("width", boxWidth)
            .attr("height", Math.abs(yScale(d.min) - yScale(d.max)))
            .attr("fill", "transparent")
            .style("cursor", "pointer")
            .on("mouseenter", function (event: MouseEvent) {
              box.attr("opacity", 0.82);
              const lines = [
                `${d.label}`,
                `最大: ${d.max}`,
                `Q3: ${d.q3}`,
                `中央値: ${d.median}`,
                `Q1: ${d.q1}`,
                `最小: ${d.min}`,
              ];
              if (d.outliers && d.outliers.length > 0) {
                lines.push(`外れ値: ${d.outliers.join(", ")}`);
              }
              show(event, lines.join("\n"));
            })
            .on("mouseleave", function () {
              box.attr("opacity", 1);
              hide();
            });
        });
      } else {
        // Horizontal: category on Y, value on X
        const yScale = d3
          .scaleBand()
          .domain(resolvedData.map((d) => d.label))
          .range([0, innerHeight])
          .padding(0.35);

        const xScale = d3
          .scaleLinear()
          .domain([domainMin - padding, domainMax + padding])
          .nice()
          .range([0, innerWidth]);

        // Grid lines
        const gridG = g
          .append("g")
          .call(
            d3
              .axisBottom(xScale)
              .tickSize(innerHeight)
              .tickFormat(() => ""),
          );
        themeGrid(gridG);

        // X axis
        const xAxisG = g
          .append("g")
          .attr("transform", `translate(0,${innerHeight})`)
          .call(d3.axisBottom(xScale).ticks(5));
        themeAxis(xAxisG);

        // Y axis
        const yAxisG = g.append("g").call(d3.axisLeft(yScale));
        themeAxis(yAxisG);

        const boxHeight = yScale.bandwidth();

        resolvedData.forEach((d, i) => {
          const y = yScale(d.label) ?? 0;
          const cy = y + boxHeight / 2;
          const seriesColor = d.color ?? mainColor;

          // Whisker — left (Q1 to min)
          const whiskerLeft = g
            .append("line")
            .attr("y1", cy)
            .attr("y2", cy)
            .attr("stroke", seriesColor)
            .attr("stroke-width", 1.5);

          // Whisker — right (Q3 to max)
          const whiskerRight = g
            .append("line")
            .attr("y1", cy)
            .attr("y2", cy)
            .attr("stroke", seriesColor)
            .attr("stroke-width", 1.5);

          // Whisker cap — left
          const capLeft = g
            .append("line")
            .attr("y1", y + boxHeight * 0.25)
            .attr("y2", y + boxHeight * 0.75)
            .attr("stroke", seriesColor)
            .attr("stroke-width", 1.5);

          // Whisker cap — right
          const capRight = g
            .append("line")
            .attr("y1", y + boxHeight * 0.25)
            .attr("y2", y + boxHeight * 0.75)
            .attr("stroke", seriesColor)
            .attr("stroke-width", 1.5);

          // Box (Q1 to Q3) — tint グラデで深みを出す（ベタ塗り回避）。
          const box = g
            .append("rect")
            .attr("class", "bp-box")
            .style("cursor", "pointer")
            .attr("y", y)
            .attr("height", boxHeight)
            .attr("rx", SHAPE_RX)
            .attr("fill", boxTint(seriesColor))
            .attr("stroke", seriesColor)
            .attr("stroke-width", 1.5);

          // Median line
          const medianLine = g
            .append("line")
            .attr("y1", y)
            .attr("y2", y + boxHeight)
            .attr("stroke", seriesColor)
            .attr("stroke-width", 2)
            .attr("stroke-opacity", 0.9);

          if (animated) {
            const delay = i * 80;

            whiskerLeft
              .attr("x1", xScale(d.q1))
              .attr("x2", xScale(d.q1))
              .transition()
              .duration(500)
              .delay(delay)
              .attr("x1", xScale(d.min))
              .attr("x2", xScale(d.q1));

            whiskerRight
              .attr("x1", xScale(d.q3))
              .attr("x2", xScale(d.q3))
              .transition()
              .duration(500)
              .delay(delay)
              .attr("x1", xScale(d.q3))
              .attr("x2", xScale(d.max));

            capLeft
              .attr("x1", xScale(d.q1))
              .attr("x2", xScale(d.q1))
              .transition()
              .duration(500)
              .delay(delay)
              .attr("x1", xScale(d.min))
              .attr("x2", xScale(d.min));

            capRight
              .attr("x1", xScale(d.q3))
              .attr("x2", xScale(d.q3))
              .transition()
              .duration(500)
              .delay(delay)
              .attr("x1", xScale(d.max))
              .attr("x2", xScale(d.max));

            box
              .attr("x", xScale(d.q1))
              .attr("width", 0)
              .transition()
              .duration(500)
              .delay(delay)
              .attr("x", xScale(d.q1))
              .attr("width", xScale(d.q3) - xScale(d.q1));

            medianLine
              .attr("x1", xScale(d.q1))
              .attr("x2", xScale(d.q1))
              .transition()
              .duration(500)
              .delay(delay)
              .attr("x1", xScale(d.median))
              .attr("x2", xScale(d.median));
          } else {
            whiskerLeft.attr("x1", xScale(d.min)).attr("x2", xScale(d.q1));
            whiskerRight.attr("x1", xScale(d.q3)).attr("x2", xScale(d.max));
            capLeft.attr("x1", xScale(d.min)).attr("x2", xScale(d.min));
            capRight.attr("x1", xScale(d.max)).attr("x2", xScale(d.max));
            box.attr("x", xScale(d.q1)).attr("width", xScale(d.q3) - xScale(d.q1));
            medianLine.attr("x1", xScale(d.median)).attr("x2", xScale(d.median));
          }

          // Outlier dots
          if (d.outliers && d.outliers.length > 0) {
            d.outliers.forEach((outlierVal) => {
              const dot = g
                .append("circle")
                .style("cursor", "pointer")
                .attr("cy", cy)
                .attr("r", 4)
                .attr("fill", "none")
                .attr("stroke", seriesColor)
                .attr("stroke-width", 1.5);

              if (animated) {
                dot
                  .attr("cx", xScale(d.median))
                  .attr("opacity", 0)
                  .transition()
                  .duration(400)
                  .delay(i * 80 + 300)
                  .attr("cx", xScale(outlierVal))
                  .attr("opacity", 1);
              } else {
                dot.attr("cx", xScale(outlierVal));
              }

              dot
                .on("mouseenter", function (event: MouseEvent) {
                  d3.select(this).attr("r", 6);
                  show(event, `外れ値: ${outlierVal}`);
                })
                .on("mouseleave", function () {
                  d3.select(this).attr("r", 4);
                  hide();
                });
            });
          }

          // Invisible hover area over box for tooltip
          g.append("rect")
            .attr("x", xScale(d.min))
            .attr("y", y)
            .attr("width", xScale(d.max) - xScale(d.min))
            .attr("height", boxHeight)
            .attr("fill", "transparent")
            .style("cursor", "pointer")
            .on("mouseenter", function (event: MouseEvent) {
              box.attr("opacity", 0.82);
              const lines = [
                `${d.label}`,
                `最大: ${d.max}`,
                `Q3: ${d.q3}`,
                `中央値: ${d.median}`,
                `Q1: ${d.q1}`,
                `最小: ${d.min}`,
              ];
              if (d.outliers && d.outliers.length > 0) {
                lines.push(`外れ値: ${d.outliers.join(", ")}`);
              }
              show(event, lines.join("\n"));
            })
            .on("mouseleave", function () {
              box.attr("opacity", 1);
              hide();
            });
        });
      }
    },
    [
      resolvedData,
      width,
      height,
      colorScheme,
      orientation,
      animated,
      innerWidth,
      innerHeight,
      mainColor,
    ],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full overflow-hidden", className)}
      role="img"
      aria-label="箱ひげ図チャート"
    >
      <svg ref={svgRef} />
      <ChartTooltip ref={tooltipRef} />
    </div>
  );
}
