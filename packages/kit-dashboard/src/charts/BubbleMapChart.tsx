import { useState, useEffect } from "react";
import * as d3 from "d3";
import * as topojson from "topojson-client";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { formatNumber } from "../lib/formatters";
import {
  resolveChartColor,
  resolveVar,
  CHART_SURFACE,
  CHART_BORDER,
  CHART_TEXT_MUTED,
} from "../lib/theme";
import { PRIMARY } from "../lib/chartRoles";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface BubbleMapPoint {
  id: string;
  label: string;
  value: number;
  lat: number;
  lon: number;
  color?: string;
  /** Human-readable meaning of bubble size, e.g. "月間アクティブユーザー数" */
  unit?: string;
}

export interface BubbleMapChartProps {
  data: BubbleMapPoint[];
  region: "world" | "japan";
  maxBubbleRadius?: number;
  colorByValue?: boolean;
  /** 値で着色する場合の色階調に使うチャート色インデックス（0始まり）。既定は 0。 */
  colorIndex?: number;
  /** Label shown in the size legend, e.g. "売上" */
  valueLabel?: string;
  width?: number;
  height?: number;
  className?: string;
}

type TopoData = Parameters<typeof topojson.feature>[0];

const WORLD_URL =
  "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
const JAPAN_URL =
  "https://raw.githubusercontent.com/dataofjapan/land/master/japan.topojson";

export function BubbleMapChart({
  data,
  region,
  maxBubbleRadius = 40,
  colorByValue = false,
  colorIndex = 0,
  valueLabel = "値",
  width: propWidth,
  height = 380,
  className,
}: BubbleMapChartProps) {
  const { show, hide, containerRef, tooltipRef } = useTooltip();
  const { width: observedWidth } = useResizeObserver(containerRef);
  const [geoData, setGeoData] = useState<TopoData | null>(null);
  const [loading, setLoading] = useState(true);

  const width = propWidth ?? observedWidth;
  const maxVal = d3.max(data, (d) => d.value) ?? 1;
  const minVal = d3.min(data, (d) => d.value) ?? 0;

  useEffect(() => {
    setLoading(true);
    const url = region === "world" ? WORLD_URL : JAPAN_URL;
    fetch(url)
      .then((r) => r.json())
      .then((json) => {
        setGeoData(json as TopoData);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [region]);

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (!geoData || width <= 0 || data.length === 0) return;

      svg.attr("width", width).attr("height", height);

      let projection: d3.GeoProjection;

      if (region === "world") {
        const countries = (geoData as { objects?: Record<string, unknown> })
          .objects?.countries;
        if (!countries) return;
        const fc = topojson.feature(
          geoData,
          countries as Parameters<typeof topojson.feature>[1],
        ) as unknown as GeoJSON.FeatureCollection;
        projection = d3.geoNaturalEarth1().fitSize([width, height], fc);
        const pathGen = d3.geoPath().projection(projection);
        svg
          .selectAll<SVGPathElement, GeoJSON.Feature>(".base-country")
          .data(fc.features)
          .join("path")
          .attr("class", "base-country")
          .attr("d", pathGen)
          .attr("stroke", CHART_BORDER)
          .attr("stroke-width", 0.5)
          .attr("fill", CHART_SURFACE);
      } else {
        const japan = (geoData as { objects?: Record<string, unknown> }).objects
          ?.japan;
        if (!japan) return;
        const fc = topojson.feature(
          geoData,
          japan as Parameters<typeof topojson.feature>[1],
        ) as unknown as GeoJSON.FeatureCollection;
        projection = d3.geoMercator().fitSize([width, height], fc);
        const pathGen = d3.geoPath().projection(projection);
        svg
          .selectAll<SVGPathElement, GeoJSON.Feature>(".base-country")
          .data(fc.features)
          .join("path")
          .attr("class", "base-country")
          .attr("d", pathGen)
          .attr("stroke", CHART_BORDER)
          .attr("stroke-width", 0.5)
          .attr("fill", CHART_SURFACE);
      }

      const radiusScale = d3
        .scaleSqrt()
        .domain([0, maxVal])
        .range([3, maxBubbleRadius]);

      const colorScale = colorByValue
        ? d3
            .scaleSequential(
              d3.interpolateRgb(
                resolveVar("--card", containerRef.current),
                resolveChartColor(colorIndex, containerRef.current),
              ),
            )
            .domain([0, maxVal])
        : null;

      // Sort descending so smaller bubbles render on top
      const sorted = [...data].sort((a, b) => b.value - a.value);

      // Draw bubbles with animated entrance
      const bubbles = svg
        .selectAll<SVGCircleElement, BubbleMapPoint>(".bubble")
        .data(sorted)
        .join("circle")
        .attr("class", "bubble")
        .style("cursor", "pointer")
        .attr("cx", (d) => {
          const projected = projection([d.lon, d.lat]);
          return projected ? projected[0] : -9999;
        })
        .attr("cy", (d) => {
          const projected = projection([d.lon, d.lat]);
          return projected ? projected[1] : -9999;
        })
        .attr("r", 0)
        // 単一指標のバブル: 値着色(colorScale)か、明示 d.color(真のカテゴリ)、
        // 既定は主系列色 PRIMARY() で単一トーンに統一（虹色 getChartColor(i) を廃止）。
        .attr("fill", (d) =>
          colorScale ? colorScale(d.value) : (d.color ?? PRIMARY()),
        )
        .attr("fill-opacity", 0)
        .attr("stroke", CHART_BORDER)
        .attr("stroke-width", 1)
        .on("mouseenter", function (event: MouseEvent, d) {
          d3.select(this).attr("fill-opacity", 1);
          const unitLine = d.unit ? `\n${d.unit}: ` : "";
          show(
            event,
            `${d.label}\n${valueLabel}: ${formatNumber(d.value, 0)}${unitLine}`,
          );
        })
        .on("mouseleave", function () {
          d3.select(this).attr("fill-opacity", 0.7);
          hide();
        });

      // Animate entrance: fade + scale from 0
      bubbles
        .transition()
        .duration(600)
        .delay((_, i) => i * 40)
        .ease(d3.easeCubicOut)
        .attr("r", (d) => radiusScale(d.value))
        .attr("fill-opacity", 0.7);

      // Bubble size legend (bottom-left area)
      const legendValues = [
        maxVal,
        maxVal / 2,
        minVal > 0 ? minVal : maxVal / 5,
      ].filter((v) => v > 0);
      if (legendValues.length === 0) return;
      const legendG = svg.append("g").attr("class", "bubble-size-legend");
      const legendPadding = 12;
      const legendX = legendPadding + maxBubbleRadius;
      let legendY = height - legendPadding - radiusScale(legendValues[0]!);

      legendValues.forEach((val, li) => {
        const r = radiusScale(val);
        legendG
          .append("circle")
          .attr("cx", legendX)
          .attr("cy", legendY)
          .attr("r", r)
          .attr("fill", "none")
          .attr("stroke", CHART_TEXT_MUTED)
          .attr("stroke-width", 1)
          .attr("stroke-dasharray", "3 2");

        legendG
          .append("line")
          .attr("x1", legendX + r)
          .attr("y1", legendY)
          .attr("x2", legendX + r + 8)
          .attr("y2", legendY)
          .attr("stroke", CHART_TEXT_MUTED)
          .attr("stroke-width", 1);

        legendG
          .append("text")
          .attr("x", legendX + r + 10)
          .attr("y", legendY)
          .attr("font-size", "10px")
          .attr("fill", CHART_TEXT_MUTED)
          .attr("dominant-baseline", "middle")
          .text(formatNumber(val, 0));

        if (li < legendValues.length - 1) {
          legendY -= radiusScale(legendValues[li + 1]!) + 4;
        }
      });

      // Legend title
      legendG
        .append("text")
        .attr("x", legendX)
        .attr(
          "y",
          height - legendPadding - radiusScale(legendValues[0]!) * 2 - 6,
        )
        .attr("font-size", "10px")
        .attr("fill", CHART_TEXT_MUTED)
        .attr("text-anchor", "middle")
        .attr("font-weight", 600)
        .text(valueLabel);
    },
    [
      geoData,
      data,
      width,
      height,
      region,
      maxBubbleRadius,
      colorByValue,
      colorIndex,
      maxVal,
      minVal,
      valueLabel,
    ],
  );

  return (
    <div ref={containerRef} className={cn("relative w-full", className)}>
      {loading ? (
        <div
          className="flex items-center justify-center text-[13px] text-muted-foreground"
          style={{ height }}
        >
          読み込み中...
        </div>
      ) : (
        <svg
          ref={svgRef}
          className="block w-full"
          aria-label="バブルマップチャート"
          role="img"
        />
      )}
      <ChartTooltip ref={tooltipRef} />
    </div>
  );
}
