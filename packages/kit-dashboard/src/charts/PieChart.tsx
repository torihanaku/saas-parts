import * as d3 from "d3";
import { useRef, useState, useCallback, useEffect } from "react";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { getChartColor } from "../lib/colorUtils";
import { formatNumber } from "../lib/formatters";
import {
  CHART_TEXT,
  CHART_TEXT_MUTED,
  CHART_BORDER,
  CHART_SURFACE,
} from "../lib/theme";
import { cn } from "../lib/cn";
import type { PieChartProps, DataPoint, PieLabelMode } from "../lib/types";

function getLabelText(
  d: d3.PieArcDatum<DataPoint>,
  total: number,
  mode: PieLabelMode,
): string {
  const pct = total > 0 ? ((d.data.value / total) * 100).toFixed(1) : "0";
  switch (mode) {
    case "none":
      return "";
    case "percent":
      return `${pct}%`;
    case "value":
      return formatNumber(d.data.value);
    case "label":
      return d.data.label;
    case "label+percent":
      return `${d.data.label} ${pct}%`;
    case "label+value":
      return `${d.data.label} ${formatNumber(d.data.value)}`;
    default:
      return `${d.data.label} ${pct}%`;
  }
}

const EXPLODE_OFFSET = 10;

// ゼロ設定でも描画できる既定データ（他チャートと同様）
const DEFAULT_PIE_DATA: DataPoint[] = [
  { label: "オーガニック", value: 50 },
  { label: "有料広告", value: 25 },
  { label: "SNS", value: 15 },
  { label: "直接", value: 10 },
];

export function PieChart({
  data = DEFAULT_PIE_DATA,
  innerRadius = 0,
  showLegend = true,
  showLabels = false,
  labelMode,
  legendPosition = "right",
  height = 300,
  className,
  sortByValue = false,
  showCenterLabel = false,
  onSliceClick,
  animationDuration,
  showDataLabels,
}: PieChartProps & {
  sortByValue?: boolean;
  showCenterLabel?: boolean;
  onSliceClick?: (label: string, value: number) => void;
  animationDuration?: number;
  showDataLabels?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width, height: containerHeight } = useResizeObserver(containerRef);
  const { state: tooltipState, show, hide } = useTooltip();

  // Track which slice index is clicked (highlighted)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const selectedIndexRef = useRef<number | null>(null);
  const handleSliceClick = useCallback((index: number) => {
    const next = selectedIndexRef.current === index ? null : index;
    selectedIndexRef.current = next;
    setSelectedIndex(next);
  }, []);

  const svgHeight = typeof height === "number" ? height : 300;

  // Resolve effective label mode — showDataLabels fallback when no explicit labelMode is set
  const effectiveLabelMode: PieLabelMode =
    labelMode !== undefined
      ? labelMode
      : showDataLabels
        ? "label+value"
        : showLabels
          ? "label+percent"
          : "none";

  const shouldShowLabels = effectiveLabelMode !== "none";

  // Sort data if requested
  const displayData = sortByValue
    ? [...data].sort((a, b) => b.value - a.value)
    : data;

  // True when data/layout changes — animate slice entry. False on click-only re-renders.
  const shouldAnimateRef = useRef(true);
  useEffect(() => {
    shouldAnimateRef.current = true;
  }, [displayData, width, svgHeight, innerRadius]);

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (width === 0 || displayData.length === 0) return;

      const centerX = width / 2;
      const centerY = svgHeight / 2;
      const outerRadius = Math.min(width, svgHeight) / 2 - 20;
      // 既定でドーナツ化（洗練＋中心に合計を置ける）。innerRadius 明示時はそれを優先。
      const ir = innerRadius > 0 ? innerRadius : outerRadius * 0.62;

      if (outerRadius <= 0) return;

      const pieGen = d3
        .pie<DataPoint>()
        .value((d) => d.value)
        .padAngle(0.015)
        .sort(null);
      const arcs = pieGen(displayData);

      const total = d3.sum(displayData, (dp) => dp.value);

      // Arc generators（細いギャップ＋角丸で高級感）
      const arcGen = d3
        .arc<d3.PieArcDatum<DataPoint>>()
        .innerRadius(ir)
        .outerRadius(outerRadius)
        .cornerRadius(2);

      // Exploded arc — moves slice outward by EXPLODE_OFFSET
      function getExplodedTransform(d: d3.PieArcDatum<DataPoint>): string {
        const midAngle = (d.startAngle + d.endAngle) / 2;
        const dx = Math.sin(midAngle) * EXPLODE_OFFSET;
        const dy = -Math.cos(midAngle) * EXPLODE_OFFSET;
        return `translate(${dx},${dy})`;
      }

      const g = svg
        .attr("width", width)
        .attr("height", svgHeight)
        .append("g")
        .attr("transform", `translate(${centerX},${centerY})`);

      // スライス描画
      const doAnimate = shouldAnimateRef.current;
      shouldAnimateRef.current = false;

      const slices = g
        .selectAll("path.pie-slice")
        .data(arcs)
        .join("path")
        .attr("class", "pie-slice")
        .attr("fill", (d, i) => d.data.color ?? getChartColor(i))
        .attr("fill-opacity", 0.92)
        .attr("stroke", CHART_SURFACE)
        .attr("stroke-width", 1)
        .style("cursor", "pointer")
        // Apply explode to already-selected slices
        .attr("transform", (_, i) =>
          i === selectedIndexRef.current
            ? getExplodedTransform(arcs[i]!)
            : "translate(0,0)",
        );

      const animDuration =
        animationDuration !== undefined ? animationDuration : 400;

      if (doAnimate && animDuration > 0) {
        // Enter animation: sweep from startAngle (zero-width arc) to final arc
        slices
          .attr("d", (d) => arcGen({ ...d, endAngle: d.startAngle }) ?? "")
          .transition()
          .duration(animDuration)
          .ease(d3.easeQuadOut)
          .attrTween("d", (d) => {
            const interpolate = d3.interpolate(
              { ...d, endAngle: d.startAngle },
              d,
            );
            return (t) => arcGen(interpolate(t)) ?? "";
          });
      } else {
        slices.attr("d", arcGen);
      }

      slices
        .on("mouseover", function (event: MouseEvent, d) {
          const i = arcs.indexOf(d);
          // Only animate if not already selected (selected keeps exploded state)
          if (i !== selectedIndexRef.current) {
            d3.select(this)
              .transition()
              .duration(150)
              .attr("transform", getExplodedTransform(d));
          }
          const pct = total > 0 ? ((d.data.value / total) * 100).toFixed(1) : "0";
          show(event, `${d.data.label}: ${formatNumber(d.data.value)} (${pct}%)`);
        })
        .on("mousemove", function (event: MouseEvent, d) {
          const pct = total > 0 ? ((d.data.value / total) * 100).toFixed(1) : "0";
          show(event, `${d.data.label}: ${formatNumber(d.data.value)} (${pct}%)`);
        })
        .on("mouseout", function (_, d) {
          const i = arcs.indexOf(d);
          // Only collapse if not selected
          if (i !== selectedIndexRef.current) {
            d3.select(this)
              .transition()
              .duration(150)
              .attr("transform", "translate(0,0)");
          }
          hide();
        })
        .on("click", function (_, d) {
          const i = arcs.indexOf(d);
          const wasSelected = i === selectedIndexRef.current;
          // Update ref immediately so subsequent renders see the new value
          selectedIndexRef.current = wasSelected ? null : i;

          // Update all slices' transforms immediately
          g.selectAll<SVGPathElement, d3.PieArcDatum<DataPoint>>(
            "path.pie-slice",
          )
            .transition()
            .duration(150)
            .attr("transform", (dd, ii) =>
              ii === selectedIndexRef.current
                ? getExplodedTransform(dd)
                : "translate(0,0)",
            );

          // Update React state for center label
          handleSliceClick(i);

          // Cross-filter callback
          onSliceClick?.(d.data.label, d.data.value);
        });

      // ラベル描画 — using arc.centroid for positioning
      if (shouldShowLabels) {
        const labelRadius = outerRadius * 1.15;
        const labelArc = d3
          .arc<d3.PieArcDatum<DataPoint>>()
          .innerRadius(labelRadius)
          .outerRadius(labelRadius);

        g.selectAll("text.pie-label")
          .data(arcs)
          .join("text")
          .attr("class", "pie-label")
          .attr("transform", (d) => `translate(${labelArc.centroid(d)})`)
          .attr("text-anchor", (d) => {
            const midAngle = (d.startAngle + d.endAngle) / 2;
            return midAngle < Math.PI ? "start" : "end";
          })
          .attr("dominant-baseline", "middle")
          .style("font-size", "11px")
          .style("fill", CHART_TEXT_MUTED)
          .style("pointer-events", "none")
          .text((d) => {
            const arcAngle = d.endAngle - d.startAngle;
            if (arcAngle < 0.2) return "";
            return getLabelText(d, total, effectiveLabelMode);
          });
      }

      // Center label for donut variant
      if (showCenterLabel && ir > 0) {
        const centerGroup = g.append("g").attr("class", "pie-center-label");

        const selIdx = selectedIndexRef.current;
        if (selIdx !== null && arcs[selIdx]) {
          const selArc = arcs[selIdx]!;
          const pct =
            total > 0 ? ((selArc.data.value / total) * 100).toFixed(1) : "0";
          centerGroup
            .append("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "auto")
            .attr("y", "-0.2em")
            .style("font-size", "18px")
            .style("font-weight", "600")
            .style("fill", CHART_TEXT)
            .text(`${pct}%`);
          centerGroup
            .append("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "hanging")
            .attr("y", "0.6em")
            .style("font-size", "11px")
            .style("fill", CHART_TEXT_MUTED)
            .text(selArc.data.label);
        } else {
          // Show total when nothing selected
          centerGroup
            .append("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "auto")
            .attr("y", "-0.2em")
            .style("font-size", "18px")
            .style("font-weight", "600")
            .style("fill", CHART_TEXT)
            .text(formatNumber(total));
          centerGroup
            .append("text")
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "hanging")
            .attr("y", "0.6em")
            .style("font-size", "11px")
            .style("fill", CHART_TEXT_MUTED)
            .text("合計");
        }
      }
    },
    [
      displayData,
      width,
      svgHeight,
      innerRadius,
      shouldShowLabels,
      effectiveLabelMode,
      showCenterLabel,
      selectedIndex,
      onSliceClick,
      animationDuration,
    ],
  );

  // 120px 以下では凡例を非表示（コンテナが小さい場合のラベル重なり防止）
  // containerHeight === 0 は ResizeObserver 未計測状態なのでデフォルト表示する
  const isLegendVisible =
    showLegend &&
    legendPosition !== "none" &&
    (containerHeight === 0 || containerHeight > 120);
  const isBottom = legendPosition === "bottom";

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex w-full flex-col items-center",
        className,
      )}
    >
      <div className="relative w-full">
        <svg
          ref={svgRef}
          role="img"
          aria-label={`円グラフ: ${displayData
            .map((d) => `${d.label} ${d.value}`)
            .join(", ")}`}
          style={{ display: "block", width: "100%" }}
        />
        {tooltipState.visible && (
          <div
            style={{
              position: "absolute",
              left: tooltipState.x + 10,
              top: tooltipState.y - 20,
              background: CHART_SURFACE,
              color: CHART_TEXT,
              border: `1px solid ${CHART_BORDER}`,
              borderRadius: 4,
              padding: "6px 10px",
              fontSize: 12,
              pointerEvents: "none",
              zIndex: 50,
              boxShadow: "0 2px 6px rgba(0,0,0,.15)",
              whiteSpace: "nowrap",
            }}
          >
            {tooltipState.content}
          </div>
        )}
      </div>

      {isLegendVisible && (
        <div
          className={cn(
            "flex flex-wrap justify-center gap-2",
            isBottom ? "gap-3 px-3 py-2" : "mt-3",
          )}
        >
          {displayData.map((d, i) => (
            <div
              key={d.label}
              className="flex items-center gap-1 text-[11px]"
              style={{ color: CHART_TEXT_MUTED }}
            >
              <span
                className="h-2 w-2 flex-shrink-0 rounded-full"
                style={{ background: d.color ?? getChartColor(i) }}
              />
              <span>{d.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
