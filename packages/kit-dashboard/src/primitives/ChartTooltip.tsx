import { cn } from "../lib/cn";

export interface ChartTooltipProps {
  x: number;
  y: number;
  content: string;
  visible: boolean;
  className?: string;
}

/**
 * D3 チャート上に絶対配置するツールチップ。色・面は shadcn の popover トークンを
 * 参照するため、取り込み先のテーマ／ダークモードに追従する。
 * 親要素は `position: relative`（もしくは同等）であること。
 */
export function ChartTooltip({ x, y, content, visible, className }: ChartTooltipProps) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-[100] -translate-x-1/2 -translate-y-full",
        "-mt-2 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs [font-variant-numeric:tabular-nums]",
        "transition-opacity duration-150",
        className,
      )}
      style={{
        left: x,
        top: y,
        opacity: visible ? 1 : 0,
        background: "var(--popover, #ffffff)",
        color: "var(--popover-foreground, #202124)",
        borderColor: "var(--border, #e0e0e0)",
        boxShadow: "0 8px 24px -6px rgba(0,0,0,0.18)",
      }}
    >
      {content}
    </div>
  );
}
