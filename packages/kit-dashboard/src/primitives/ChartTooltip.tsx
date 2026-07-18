import { forwardRef } from "react";
import { cn } from "../lib/cn";

export interface ChartTooltipProps {
  className?: string;
}

/**
 * D3 チャート上に絶対配置するツールチップ。**useTooltip が ref 経由で
 * 位置・本文・可視性を命令的に書き込む**（props ではなく DOM 直更新）。
 * これによりホバーで React 再レンダーが起きず flicker を防ぐ。
 * 親要素は `position: relative`（もしくは同等）であること。
 * 色・面は shadcn の popover トークン参照でテーマ/ダークに追従。
 */
export const ChartTooltip = forwardRef<HTMLDivElement, ChartTooltipProps>(
  function ChartTooltip({ className }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "pointer-events-none absolute left-0 top-0 z-[100] -translate-x-1/2 -translate-y-full",
          "-mt-2 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs [font-variant-numeric:tabular-nums]",
          "transition-opacity duration-150",
          className,
        )}
        style={{
          opacity: 0,
          background: "var(--popover, #ffffff)",
          color: "var(--popover-foreground, #202124)",
          borderColor: "var(--border, #e0e0e0)",
          boxShadow: "0 8px 24px -6px rgba(0,0,0,0.18)",
        }}
      />
    );
  },
);
