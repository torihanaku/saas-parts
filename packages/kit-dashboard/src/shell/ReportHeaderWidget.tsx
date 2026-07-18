import { cn } from "../lib/cn";

export interface ReportHeaderWidgetProps {
  /** レポート名（見出し） */
  title?: string;
  /** サブタイトル / 説明 */
  subtitle?: string;
  /** 任意ロゴ画像 URL */
  logoUrl?: string;
  /** アクティブなフィルタ数（>0 で「クリア」チップを表示） */
  activeFilterCount?: number;
  /** 「すべてクリア」押下時のコールバック */
  onClearAll?(): void;
  /** 作成日を表示するか */
  showDate?: boolean;
  /** 日付フォーマット */
  dateFormat?: "YYYY/MM/DD" | "YYYY-MM-DD";
  /** 背景モード */
  bgMode?: "gradient" | "solid" | "transparent";
  bgColor?: string;
  bgColor2?: string;
  bgAngle?: number;
  textColor?: string;
  className?: string;
}

/**
 * ダッシュボード上部のレポートヘッダー。store 非依存。
 * active filter 情報（activeFilterCount / onClearAll）は props 化されており、
 * 消費側アプリがフィルタ状態を管理する。
 */
export function ReportHeaderWidget({
  title = "レポート",
  subtitle,
  logoUrl,
  activeFilterCount = 0,
  onClearAll,
  showDate = true,
  dateFormat = "YYYY/MM/DD",
  bgMode = "gradient",
  bgColor = "#4285F4",
  bgColor2 = "#34A853",
  bgAngle = 135,
  textColor,
  className,
}: ReportHeaderWidgetProps) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const dateStr = dateFormat === "YYYY/MM/DD" ? `${y}/${m}/${d}` : `${y}-${m}-${d}`;

  function getBackground(): string {
    if (bgMode === "transparent") return "transparent";
    if (bgMode === "solid") return bgColor;
    return `linear-gradient(${bgAngle}deg, ${bgColor} 0%, ${bgColor2} 100%)`;
  }

  const isTransparent = bgMode === "transparent";
  const autoTextColor = isTransparent ? "var(--foreground)" : "#fff";
  const resolvedTextColor = textColor ?? autoTextColor;
  const hasActiveFilters = activeFilterCount > 0;

  return (
    <div
      className={cn("flex h-full flex-col justify-center rounded px-4 py-3", className)}
      style={{ background: getBackground(), color: resolvedTextColor }}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {logoUrl && (
            <img
              src={logoUrl}
              alt=""
              className="h-8 w-8 flex-shrink-0 rounded object-contain"
            />
          )}
          <div className="min-w-0">
            <h2 className="m-0 truncate text-[20px] font-bold tracking-[-0.3px]">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 mb-0 truncate text-[13px] opacity-90">{subtitle}</p>
            )}
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-3">
          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => onClearAll?.()}
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium"
              style={{ background: "rgba(255,255,255,0.22)", color: "inherit" }}
            >
              フィルター {activeFilterCount} 件をクリア
            </button>
          )}
          {showDate && (
            <div
              className="text-right text-[12px]"
              style={{ opacity: isTransparent ? 0.7 : 0.85 }}
            >
              <div>作成日</div>
              <div className="font-semibold">{dateStr}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
