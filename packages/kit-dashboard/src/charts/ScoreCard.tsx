import { useRef } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { getChartColor } from "../lib/colorUtils";
import { formatCompact } from "../lib/formatters";
import {
  CHART_TEXT,
  CHART_TEXT_MUTED,
  CHART_BORDER,
  CHART_POSITIVE,
  CHART_NEGATIVE,
  CHART_WARNING,
} from "../lib/theme";
import { cn } from "../lib/cn";
import type { ScoreCardProps } from "../lib/types";

export type { ScoreCardProps, ScoreCardVariant } from "../lib/types";

export function ScoreCard({
  title,
  value,
  previousValue,
  comparisonValue,
  changeLabel = "vs 前期",
  unit,
  sparklineData,
  formatter,
  className,
  variant = "standard",
  progressMax = 100,
  thresholdGood,
  thresholdBad,
  valueColor,
  // スパークラインは brand 単色が既定（増減の意味は delta チップの色が担う＝色の氾濫回避）。
  sparklineUpColor = "var(--chart-1, #4f46e5)",
  sparklineDownColor = "var(--chart-1, #4f46e5)",
}: ScoreCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const trendValue =
    previousValue != null && typeof value === "number" && previousValue !== 0
      ? ((value - previousValue) / Math.abs(previousValue)) * 100
      : null;

  // delta チップの色は増減の意味を運ぶ（増=positive/減=negative/0=muted）。
  const deltaColor =
    trendValue != null && trendValue > 0
      ? CHART_POSITIVE
      : trendValue != null && trendValue < 0
        ? CHART_NEGATIVE
        : CHART_TEXT_MUTED;
  // スパークラインの色は方向で up/down 色を使う（既定は両方 brand 単色）。
  const trendColor =
    trendValue != null && trendValue > 0
      ? sparklineUpColor
      : trendValue != null && trendValue < 0
        ? sparklineDownColor
        : sparklineUpColor;

  // 符号は矢印が担い、数字は絶対値（formatPercent は符号を再付与するので使わない＝「赤なのに+31%」の是正）。
  const trendLabel =
    trendValue != null
      ? `${trendValue > 0 ? "↑" : trendValue < 0 ? "↓" : "±"}${Math.abs(
          trendValue,
        ).toFixed(1)}%`
      : null;

  // Determine display value based on variant
  const displayValue = (() => {
    if (variant === "compact" && typeof value === "number") {
      return formatCompact(value);
    }
    if (typeof value === "number" && formatter) {
      return formatter(value);
    }
    return String(value);
  })();

  // Progress ratio (clamped 0–1)
  const progressRatio =
    typeof value === "number"
      ? Math.min(1, Math.max(0, value / progressMax))
      : 0;

  const sparklineRef = useD3<SVGSVGElement>(
    (svg) => {
      if (!sparklineData || sparklineData.length === 0) return;

      const width = containerRef.current?.clientWidth ?? 200;
      const height = 40;

      svg.selectAll("*").remove();
      svg.attr("width", width).attr("height", height);

      const xScale = d3
        .scaleLinear()
        .domain([0, sparklineData.length - 1])
        .range([0, width]);

      const yMin = d3.min(sparklineData) ?? 0;
      const yMax = d3.max(sparklineData) ?? 1;
      const yScale = d3
        .scaleLinear()
        .domain([yMin, yMax === yMin ? yMax + 1 : yMax])
        .range([height - 2, 2]);

      const gradientId = `sparkline-gradient-${Math.random()
        .toString(36)
        .slice(2)}`;

      // Gradient fill below the line
      const defs = svg.append("defs");
      const gradient = defs
        .append("linearGradient")
        .attr("id", gradientId)
        .attr("x1", "0")
        .attr("y1", "0")
        .attr("x2", "0")
        .attr("y2", "1");
      gradient
        .append("stop")
        .attr("offset", "0%")
        .attr("stop-color", trendColor)
        .attr("stop-opacity", 0.14);
      gradient
        .append("stop")
        .attr("offset", "100%")
        .attr("stop-color", trendColor)
        .attr("stop-opacity", 0);

      const curve = d3.curveCatmullRom.alpha(0.5);

      const area = d3
        .area<number>()
        .x((_, i) => xScale(i))
        .y0(height)
        .y1((d) => yScale(d))
        .curve(curve);

      const line = d3
        .line<number>()
        .x((_, i) => xScale(i))
        .y((d) => yScale(d))
        .curve(curve);

      // Area fill first (below line)
      svg
        .append("path")
        .datum(sparklineData)
        .attr("d", area)
        .attr("fill", `url(#${gradientId})`);

      // Line on top
      svg
        .append("path")
        .datum(sparklineData)
        .attr("d", line)
        .attr("fill", "none")
        .attr("stroke", trendColor)
        .attr("stroke-width", 2)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round");

      // 最新点のみドット（card 背景で抜く）
      const lastIdx = sparklineData.length - 1;
      svg
        .append("circle")
        .attr("cx", xScale(lastIdx))
        .attr("cy", yScale(sparklineData[lastIdx] ?? 0))
        .attr("r", 2.5)
        .attr("fill", trendColor)
        .attr("stroke", "var(--card)")
        .attr("stroke-width", 1.5);
    },
    [sparklineData, trendColor],
  );

  // D3 arc for progress-circle variant
  const progressCircleRef = useD3<SVGSVGElement>(
    (svg) => {
      if (variant !== "progress-circle") return;

      const size = 70;
      const cx = size / 2;
      const cy = size / 2;
      const radius = 30;
      const strokeWidth = 4;

      svg
        .attr("width", size)
        .attr("height", size)
        .attr("viewBox", `0 0 ${size} ${size}`);

      const arcGen = d3
        .arc<{ startAngle: number; endAngle: number }>()
        .innerRadius(radius - strokeWidth)
        .outerRadius(radius)
        .startAngle((d) => d.startAngle)
        .endAngle((d) => d.endAngle);

      const fullAngle = Math.PI * 2;

      // Background arc (full circle)
      svg
        .append("path")
        .attr("transform", `translate(${cx},${cy})`)
        .attr("d", arcGen({ startAngle: 0, endAngle: fullAngle }) ?? "")
        .attr("fill", CHART_BORDER);

      // Fill arc (progress portion, starting from top = -π/2)
      const fillEnd = -Math.PI / 2 + progressRatio * fullAngle;
      svg
        .append("path")
        .attr("transform", `translate(${cx},${cy})`)
        .attr("d", arcGen({ startAngle: -Math.PI / 2, endAngle: fillEnd }) ?? "")
        .attr("fill", getChartColor(0));
    },
    [variant, progressRatio],
  );

  // Threshold color bar
  let statusBarColor: string | null = null;
  if (thresholdGood !== undefined || thresholdBad !== undefined) {
    const numVal = parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
    if (!isNaN(numVal)) {
      if (thresholdGood !== undefined && numVal >= thresholdGood) {
        statusBarColor = CHART_POSITIVE; // 緑
      } else if (thresholdBad !== undefined && numVal < thresholdBad) {
        statusBarColor = CHART_NEGATIVE; // 赤
      } else {
        statusBarColor = CHART_WARNING; // 黄
      }
    }
  }

  // Period-over-period comparison
  // comparisonValue が純粋な数値文字列の場合のみ計算する。テキストラベル（日本語等）は計算しない
  let comparisonDisplay: {
    prev: string;
    diff: string;
    pct: string;
    color: string;
  } | null = null;
  if (comparisonValue) {
    const stripped = comparisonValue.replace(/[^0-9.-]/g, "");
    const looksNumeric =
      stripped.length > 0 && stripped === comparisonValue.trim();
    if (looksNumeric) {
      const curr = parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
      const prev = parseFloat(stripped);
      if (!isNaN(curr) && !isNaN(prev) && prev !== 0) {
        const diff = curr - prev;
        const pct = (diff / Math.abs(prev)) * 100;
        comparisonDisplay = {
          prev: comparisonValue,
          diff: `${diff >= 0 ? "+" : ""}${diff.toLocaleString("ja-JP", {
            maximumFractionDigits: 1,
          })}`,
          pct: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
          color: diff >= 0 ? CHART_POSITIVE : CHART_NEGATIVE,
        };
      }
    }
  }

  // trend-only variant: shows title + sparkline only, no big value
  if (variant === "trend-only") {
    return (
      <div
        className={cn(
          "flex h-full min-h-0 flex-col overflow-hidden rounded-md border px-3.5 py-2.5 shadow-sm",
          className,
        )}
        style={{
          background: "var(--card)",
          borderColor: CHART_BORDER,
        }}
        ref={containerRef}
        role="figure"
        aria-label={`${title}`}
      >
        <div className="mb-2 text-[13px]" style={{ color: CHART_TEXT_MUTED }}>
          {title}
        </div>
        {sparklineData && sparklineData.length > 0 ? (
          <div className="mt-3 w-full">
            <svg
              ref={sparklineRef}
              style={{ width: "100%", height: 40, display: "block" }}
            />
          </div>
        ) : (
          <div
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: CHART_TEXT_MUTED,
              marginTop: 4,
            }}
          >
            —
          </div>
        )}
      </div>
    );
  }

  // comparison variant: shows current vs previous side by side
  if (variant === "comparison") {
    const currNum =
      typeof value === "number"
        ? value
        : parseFloat(String(value).replace(/[^0-9.-]/g, ""));
    const prevNum = previousValue ?? null;
    let diffPct: string | null = null;
    let diffColor = CHART_TEXT_MUTED;
    if (prevNum != null && !isNaN(currNum) && prevNum !== 0) {
      const pct = ((currNum - prevNum) / Math.abs(prevNum)) * 100;
      diffPct = `${pct >= 0 ? "↑" : "↓"}${Math.abs(pct).toFixed(1)}%`;
      diffColor = pct >= 0 ? CHART_POSITIVE : CHART_NEGATIVE;
    }
    const fmt = (v: number | null) =>
      v == null ? "—" : formatter ? formatter(v) : v.toLocaleString("ja-JP");
    return (
      <div
        className={cn(
          "flex h-full min-h-0 flex-col overflow-hidden rounded-md border px-3.5 py-2.5 shadow-sm",
          className,
        )}
        style={{
          background: "var(--card)",
          borderColor: CHART_BORDER,
        }}
        ref={containerRef}
        role="figure"
        aria-label={`${title}: 今期 ${fmt(currNum)} 前期 ${fmt(prevNum)}`}
      >
        <div className="mb-2 text-[13px]" style={{ color: CHART_TEXT_MUTED }}>
          {title}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <div
              style={{ fontSize: 11, color: CHART_TEXT_MUTED, marginBottom: 2 }}
            >
              今期
            </div>
            <div
              className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-bold leading-none"
              style={{
                fontSize: "clamp(18px, 3.5vw, 32px)",
                color: valueColor ?? CHART_TEXT,
              }}
            >
              {fmt(!isNaN(currNum) ? currNum : null)}
              {unit ? (
                <span
                  className="text-[13px]"
                  style={{ color: CHART_TEXT_MUTED }}
                >
                  {unit}
                </span>
              ) : null}
            </div>
          </div>
          {diffPct && (
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: diffColor,
                flexShrink: 0,
              }}
            >
              {diffPct}
            </div>
          )}
          <div style={{ textAlign: "center" }}>
            <div
              style={{ fontSize: 11, color: CHART_TEXT_MUTED, marginBottom: 2 }}
            >
              前期
            </div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: CHART_TEXT,
              }}
            >
              {fmt(prevNum)}
              {unit ? (
                <span
                  className="text-[13px]"
                  style={{ color: CHART_TEXT_MUTED }}
                >
                  {unit}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isCompact = variant === "compact";

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-lg border",
        isCompact ? "p-4" : "p-5",
        className,
      )}
      style={{
        background: "var(--card)",
        borderColor: CHART_BORDER,
        boxShadow: "var(--elev-rest, 0 1px 2px rgba(0,0,0,0.06))",
      }}
      ref={containerRef}
      role="figure"
      aria-label={`${title}: ${displayValue}${unit ? " " + unit : ""}`}
    >
      {statusBarColor && (
        <div
          className="h-[2px] shrink-0"
          style={{
            background: statusBarColor,
            width: "calc(100% + 40px)",
            margin: isCompact
              ? "-16px -16px 12px -16px"
              : "-20px -20px 12px -20px",
          }}
        />
      )}
      {/* KPIラベル（計器的：小さく淡く tracking） */}
      <div
        className="mb-2 truncate text-[11px] font-semibold"
        style={{ color: CHART_TEXT_MUTED, letterSpacing: "0.06em" }}
      >
        {title}
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={cn(
            "tnum font-semibold leading-none",
            isCompact
              ? ""
              : "max-w-full overflow-hidden text-ellipsis whitespace-nowrap",
          )}
          style={{
            color: valueColor ?? CHART_TEXT,
            fontFamily: "var(--font-display, inherit)",
            fontSize: isCompact ? "22px" : "clamp(24px, 3vw, 32px)",
            letterSpacing: "-0.02em",
          }}
        >
          {displayValue}
        </span>
        {unit && (
          <span className="text-[13px]" style={{ color: CHART_TEXT_MUTED }}>
            {unit}
          </span>
        )}
        {trendLabel && (
          <span
            className="tnum inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold"
            style={{
              color: deltaColor,
              background: `color-mix(in srgb, ${deltaColor} 12%, transparent)`,
            }}
          >
            {trendLabel}
          </span>
        )}
      </div>

      {variant === "progress-bar" && (
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-[3px]"
          style={{ background: CHART_BORDER }}
        >
          <div
            className="h-full rounded-[3px] transition-[width] duration-500"
            style={{
              width: `${progressRatio * 100}%`,
              background: getChartColor(0),
            }}
            role="progressbar"
            aria-valuenow={typeof value === "number" ? value : 0}
            aria-valuemin={0}
            aria-valuemax={progressMax}
          />
        </div>
      )}

      {variant === "progress-circle" && (
        <div className="mt-1 flex justify-center">
          <svg ref={progressCircleRef} aria-hidden="true" />
        </div>
      )}

      {/* スパークライン枠は常に高さ 40px を確保（データ無しは薄い破線ベースラインでカード高さを揃える）。 */}
      {variant === "standard" && (
        <div className="mt-auto w-full pt-4" style={{ minHeight: 40 }}>
          {sparklineData && sparklineData.length > 0 ? (
            <svg
              ref={sparklineRef}
              style={{ width: "100%", height: 40, display: "block" }}
            />
          ) : (
            <div
              style={{
                height: 40,
                borderBottom: `1px dashed ${CHART_BORDER}`,
                opacity: 0.5,
              }}
            />
          )}
        </div>
      )}

      {/* 期間比較（comparisonValue が数値で渡された時のみ）。裸の changeLabel は出さない＝宙ぶらりん解消。 */}
      {comparisonDisplay && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px]" style={{ color: CHART_TEXT_MUTED }}>
            {changeLabel}: {comparisonDisplay.prev}
          </span>
          <span
            className="tnum text-[11px] font-semibold"
            style={{ color: comparisonDisplay.color }}
          >
            {comparisonDisplay.diff} ({comparisonDisplay.pct})
          </span>
        </div>
      )}
    </div>
  );
}
