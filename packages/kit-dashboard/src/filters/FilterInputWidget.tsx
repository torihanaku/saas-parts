import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

export interface FilterInputWidgetProps {
  label?: string;
  placeholder?: string;
  /** 制御値。指定時はこの文字列を表示（消費側で状態管理）。 */
  value?: string;
  /** 非制御時の初期値。 */
  defaultValue?: string;
  /** 入力確定時に呼ばれる（空文字はクリアの意）。 */
  onChange?: (text: string) => void;
  /** onChange を遅延させる ms。0 で即時。既定 0（元挙動は即時）。 */
  debounceMs?: number;
  className?: string;
}

/**
 * テキスト検索フィルター。store 非依存の制御/非制御両対応。
 * クリア（× or 空入力）時は `onChange("")` を呼ぶ。
 * `debounceMs` を指定すると onChange をデバウンスできる（表示は即時）。
 */
export function FilterInputWidget({
  label = "フィルター",
  placeholder = "検索...",
  value,
  defaultValue,
  onChange,
  debounceMs = 0,
  className,
}: FilterInputWidgetProps) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = useState<string>(defaultValue ?? "");
  const current = isControlled ? value! : internal;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const emit = (next: string) => {
    if (!onChange) return;
    if (debounceMs > 0) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => onChange(next), debounceMs);
    } else {
      onChange(next);
    }
  };

  const handleChange = (next: string) => {
    if (!isControlled) setInternal(next);
    emit(next);
  };

  const handleClear = () => {
    if (timer.current) clearTimeout(timer.current);
    if (!isControlled) setInternal("");
    onChange?.("");
  };

  return (
    <div
      className={cn(
        "flex h-full flex-col justify-center gap-1.5 px-3 py-2",
        className,
      )}
    >
      {label && (
        <span className="whitespace-nowrap text-xs font-medium text-[color:var(--muted-foreground)]">
          {label}
        </span>
      )}
      <div className="flex items-center gap-1.5 rounded border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1 focus-within:border-[color:var(--chart-1,#4285f4)]">
        <svg
          className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--muted-foreground)]"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="9" cy="9" r="6" />
          <line x1="13.5" y1="13.5" x2="18" y2="18" />
        </svg>
        <input
          type="text"
          className="min-w-0 flex-1 border-none bg-transparent text-xs text-[color:var(--foreground)] outline-none placeholder:text-[color:var(--muted-foreground)]"
          placeholder={placeholder}
          value={current}
          onChange={(e) => handleChange(e.target.value)}
        />
        {current && (
          <button
            type="button"
            className="flex-shrink-0 cursor-pointer border-none bg-transparent p-0 text-sm leading-none text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]"
            onClick={handleClear}
            aria-label="クリア"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
