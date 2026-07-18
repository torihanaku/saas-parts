import { cn } from "../lib/cn";
import { CHART_NEGATIVE } from "../lib/theme";

export interface FilterResetWidgetProps {
  /** ボタンのラベル。未指定時は既定文言。 */
  label?: string;
  /** 現在アクティブなフィルタ数（>0 でリセット可能・強調表示） */
  activeCount?: number;
  /** リセット押下時のコールバック */
  onReset?(): void;
  /** 明示的な無効化（レビューモード等） */
  disabled?: boolean;
  className?: string;
}

/**
 * 全フィルタをリセットするボタン。store 非依存の制御コンポーネント。
 * activeCount>0 のときのみ有効化され、CHART_NEGATIVE 背景で強調される。
 */
export function FilterResetWidget({
  label = "フィルターをリセット",
  activeCount = 0,
  onReset,
  disabled = false,
  className,
}: FilterResetWidgetProps) {
  const active = activeCount > 0;
  const isDisabled = disabled || !active;

  return (
    <button
      type="button"
      onClick={() => {
        if (!isDisabled) onReset?.();
      }}
      disabled={isDisabled}
      className={cn(
        "flex h-full w-full items-center justify-center gap-1.5 rounded-md border text-[13px] font-medium transition-all",
        "border-[color:var(--border)]",
        className,
      )}
      style={{
        background: active ? CHART_NEGATIVE : "var(--muted)",
        color: active ? "#fff" : "var(--muted-foreground)",
        cursor: active ? "pointer" : "default",
      }}
    >
      🔄 {label}
      {active && (
        <span
          className="rounded-[10px] px-1.5 py-px text-[11px]"
          style={{ background: "rgba(255,255,255,0.3)" }}
        >
          {activeCount}
        </span>
      )}
    </button>
  );
}
