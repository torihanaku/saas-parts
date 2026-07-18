import { cn } from "../lib/cn";
import { getChartColor } from "../lib/colorUtils";

export interface SectionHeaderProps {
  /** セクションタイトル */
  title?: string;
  /** 補足テキスト（メモ） */
  subtitle?: string;
  /** ストライプのアクセント色。未指定時はチャートパレット先頭色。 */
  color?: string;
  className?: string;
}

/**
 * セクション区切りバナー。左端のストライプ + タイトル + 補足。store 非依存。
 */
export function SectionHeader({
  title = "セクション",
  subtitle,
  color,
  className,
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex h-full items-center gap-2 overflow-hidden rounded px-3",
        "bg-[color:var(--muted)]",
        className,
      )}
    >
      <span
        className="h-5 w-1 flex-shrink-0 rounded-sm"
        style={{ background: color ?? getChartColor(0) }}
      />
      <span className="truncate text-[13px] font-semibold text-[color:var(--foreground)]">
        {title}
      </span>
      {subtitle && (
        <span className="truncate text-[11px] text-[color:var(--muted-foreground)]">
          {subtitle}
        </span>
      )}
    </div>
  );
}
