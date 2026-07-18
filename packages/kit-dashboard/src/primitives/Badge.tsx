import type { CSSProperties } from "react";
import { cn } from "../lib/cn";
import {
  CHART_NEGATIVE,
  CHART_POSITIVE,
  CHART_WARNING,
} from "../lib/theme";
import { getChartColor } from "../lib/colorUtils";

export type BadgeVariant =
  | "default"
  | "positive"
  | "negative"
  | "warning"
  | "info";

export interface BadgeProps {
  label: string;
  variant?: BadgeVariant;
  className?: string;
}

/**
 * variant 色はテーマ非依存トークンへ写像（DashMock のハードコード hex を廃止）:
 *   positive → CHART_POSITIVE / negative → CHART_NEGATIVE /
 *   warning  → CHART_WARNING  / info     → getChartColor(0)。
 * 背景は同色を低不透明度（color-mix）で敷き、ダーク追従させる。
 */
const VARIANT_STYLE: Record<BadgeVariant, CSSProperties> = {
  default: {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "1px solid var(--border)",
  },
  positive: {
    backgroundColor: `color-mix(in srgb, ${CHART_POSITIVE} 15%, transparent)`,
    color: CHART_POSITIVE,
  },
  negative: {
    backgroundColor: `color-mix(in srgb, ${CHART_NEGATIVE} 15%, transparent)`,
    color: CHART_NEGATIVE,
  },
  warning: {
    backgroundColor: `color-mix(in srgb, ${CHART_WARNING} 18%, transparent)`,
    color: CHART_WARNING,
  },
  info: {
    backgroundColor: `color-mix(in srgb, ${getChartColor(0)} 15%, transparent)`,
    color: getChartColor(0),
  },
};

export function Badge({ label, variant = "default", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium leading-normal whitespace-nowrap",
        className,
      )}
      style={VARIANT_STYLE[variant]}
    >
      {label}
    </span>
  );
}
