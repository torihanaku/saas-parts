import { useState, useEffect, useRef } from "react";
import * as d3 from "d3";
import * as topojson from "topojson-client";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { formatNumber } from "../lib/formatters";
import { resolveChartColor, CHART_SURFACE, CHART_BORDER } from "../lib/theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface GeoDataPoint {
  id: string;
  label: string;
  value: number;
}

export interface GeoChartProps {
  data: GeoDataPoint[];
  region: "world" | "japan";
  /** 値の色階調に使うチャート色インデックス（0始まり）。既定は 0。 */
  colorIndex?: number;
  width?: number;
  height?: number;
  className?: string;
  /** Widget id used for cross-filter. If provided, clicking a region invokes onRegionClick. */
  widgetId?: string;
  /** クリックされた地域を親に通知する（クロスフィルター配線用）。 */
  onRegionClick?: (label: string, widgetId: string | undefined) => void;
}

type TopoData = Parameters<typeof topojson.feature>[0];

const WORLD_URL =
  "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
const JAPAN_URL =
  "https://raw.githubusercontent.com/dataofjapan/land/master/japan.topojson";

export function GeoChart({
  data,
  region,
  colorIndex = 0,
  width: propWidth,
  height = 380,
  className,
  widgetId,
  onRegionClick,
}: GeoChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { state: tooltipState, show, hide } = useTooltip();
  const [geoData, setGeoData] = useState<TopoData | null>(null);
  const [loading, setLoading] = useState(true);

  const width = propWidth ?? observedWidth;

  // Build lookup map: id -> value and label
  const dataMap = new Map<string, GeoDataPoint>();
  data.forEach((d) => dataMap.set(d.id, d));

  const maxVal = d3.max(data, (d) => d.value) ?? 1;

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
      if (!geoData || width <= 0) return;

      svg.attr("width", width).attr("height", height);

      // 陸地の基調(CHART_SURFACE) → 値の色(チャート色) へ補間する
      // 選択階調。テーマトークンから実体を解決して d3 補間に渡す。
      const surfaceColor = resolveSurface(containerRef.current);
      const valueColor = resolveChartColor(colorIndex, containerRef.current);
      const colorScale = d3
        .scaleSequential(d3.interpolateRgb(surfaceColor, valueColor))
        .domain([0, maxVal])
        .clamp(true);

      let features: GeoJSON.Feature[];
      let projection: d3.GeoProjection;

      if (region === "world") {
        // countries-110m uses object key "countries"
        const countries = (geoData as { objects?: Record<string, unknown> })
          .objects?.countries;
        if (!countries) return;
        const fc = topojson.feature(
          geoData,
          countries as Parameters<typeof topojson.feature>[1],
        ) as unknown as GeoJSON.FeatureCollection;
        features = fc.features;
        projection = d3.geoNaturalEarth1().fitSize([width, height], fc);
      } else {
        // japan.topojson uses object key "japan"
        const japan = (geoData as { objects?: Record<string, unknown> }).objects
          ?.japan;
        if (!japan) return;
        const fc = topojson.feature(
          geoData,
          japan as Parameters<typeof topojson.feature>[1],
        ) as unknown as GeoJSON.FeatureCollection;
        features = fc.features;
        projection = d3.geoMercator().fitSize([width, height], fc);
      }

      const pathGen = d3.geoPath().projection(projection);

      function lookupIdOf(f: GeoJSON.Feature): string {
        if (region === "world") {
          let id = String(f.id ?? "");
          if (id && id !== "undefined") {
            id = id.padStart(3, "0");
          }
          return id;
        }
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const rawId = props.id ?? props.code ?? "";
        return String(rawId).padStart(2, "0");
      }

      svg
        .selectAll<SVGPathElement, GeoJSON.Feature>(".country")
        .data(features)
        .join("path")
        .attr("class", "country")
        .style("cursor", "pointer")
        .attr("d", pathGen)
        .attr("stroke", CHART_BORDER)
        .attr("stroke-width", 0.5)
        .attr("fill", (f) => {
          const point = dataMap.get(lookupIdOf(f));
          return point ? colorScale(point.value) : CHART_SURFACE;
        })
        .on("mouseenter", function (event: MouseEvent, f) {
          const lookupId = lookupIdOf(f);
          const point = dataMap.get(lookupId);
          d3.select(this).attr("opacity", 0.75);
          if (point) {
            show(event, `${point.label}: ${formatNumber(point.value, 0)}`);
          } else {
            const props = (f.properties ?? {}) as Record<string, string>;
            const name = props.name ?? props.nam_ja ?? lookupId;
            show(event, name);
          }
        })
        .on("mouseleave", function () {
          d3.select(this).attr("opacity", 1);
          hide();
        })
        .on("click", function (_event: MouseEvent, f) {
          if (!widgetId) return;
          const lookupId = lookupIdOf(f);
          const point = dataMap.get(lookupId);
          const props = (f.properties ?? {}) as Record<string, string>;
          const regionName = point?.label ?? props.name ?? lookupId;
          onRegionClick?.(regionName, widgetId);
        });
    },
    [geoData, data, width, height, colorIndex, region, maxVal, widgetId, onRegionClick],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
    >
      {loading ? (
        <div
          className="flex items-center justify-center text-[13px] text-muted-foreground"
          style={{ height }}
        >
          読み込み中...
        </div>
      ) : (
        <>
          <svg
            ref={svgRef}
            className="block w-full"
            aria-label="地図チャート"
            role="img"
          />
          <div className="flex items-center gap-2 pt-2 text-[11px] text-muted-foreground">
            <span>0</span>
            <svg width={120} height={8} className="h-2 w-[120px] flex-shrink-0 rounded">
              <defs>
                <linearGradient id={`geo-gradient-${colorIndex}`}>
                  <stop offset="0%" stopColor={CHART_SURFACE} />
                  <stop offset="100%" stopColor={resolveChartColor(colorIndex)} />
                </linearGradient>
              </defs>
              <rect
                width={120}
                height={8}
                rx={4}
                fill={`url(#geo-gradient-${colorIndex})`}
              />
            </svg>
            <span>{formatNumber(maxVal, 0)}</span>
          </div>
        </>
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

/** CHART_SURFACE の実体色を解決（d3 補間に渡すため）。 */
function resolveSurface(el: Element | null): string {
  if (typeof window === "undefined" || typeof getComputedStyle === "undefined") {
    return "#ffffff";
  }
  const target = el ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!target) return "#ffffff";
  const val = getComputedStyle(target).getPropertyValue("--card").trim();
  return val || "#ffffff";
}
