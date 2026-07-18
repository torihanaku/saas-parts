import { useMemo, useState } from "react";
import { cn } from "../lib/cn";

export interface DateRange {
  start: Date;
  end: Date;
}

export interface FilterDateWidgetProps {
  label?: string;
  /** 現在選択中の範囲（null=未選択）。active 表示（×リセット）の駆動に使う。 */
  value?: DateRange | null;
  /** 範囲確定時（プリセット選択 or カスタム両端入力）に呼ばれる。リセットは null。 */
  onChange?: (range: DateRange | null) => void;
  className?: string;
}

type Preset =
  | "今日"
  | "過去7日"
  | "過去30日"
  | "今月"
  | "先月"
  | "今四半期"
  | "今年"
  | "カスタム";

const PRESETS: Preset[] = [
  "今日",
  "過去7日",
  "過去30日",
  "今月",
  "先月",
  "今四半期",
  "今年",
  "カスタム",
];

function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function computeRange(preset: Preset): { start: string; end: string } | null {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (preset) {
    case "今日": {
      const s = fmt(today);
      return { start: s, end: s };
    }
    case "過去7日": {
      const s = new Date(today);
      s.setDate(s.getDate() - 6);
      return { start: fmt(s), end: fmt(today) };
    }
    case "過去30日": {
      const s = new Date(today);
      s.setDate(s.getDate() - 29);
      return { start: fmt(s), end: fmt(today) };
    }
    case "今月": {
      const s = new Date(today.getFullYear(), today.getMonth(), 1);
      const e = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { start: fmt(s), end: fmt(e) };
    }
    case "先月": {
      const s = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const e = new Date(today.getFullYear(), today.getMonth(), 0);
      return { start: fmt(s), end: fmt(e) };
    }
    case "今四半期": {
      const q = Math.floor(today.getMonth() / 3);
      const s = new Date(today.getFullYear(), q * 3, 1);
      const e = new Date(today.getFullYear(), q * 3 + 3, 0);
      return { start: fmt(s), end: fmt(e) };
    }
    case "今年": {
      const s = new Date(today.getFullYear(), 0, 1);
      const e = new Date(today.getFullYear(), 11, 31);
      return { start: fmt(s), end: fmt(e) };
    }
    case "カスタム":
    default:
      return null;
  }
}

function displayDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${y}/${m}/${d}`;
}

/** ISO日付文字列(YYYY-MM-DD)をローカル 0時の Date に変換 */
function toDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/**
 * プリセット + カスタム範囲の日付フィルター。カレンダー/プリセット UI を保持し、
 * store 依存を props（value / onChange）に脱結合した制御コンポーネント。
 * 確定時は `onChange({ start, end })`、リセット時は `onChange(null)`。
 */
export function FilterDateWidget({
  label = "日付範囲",
  value,
  onChange,
  className,
}: FilterDateWidgetProps) {
  const [preset, setPreset] = useState<Preset>("過去30日");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // active 判定は props の value で駆動（store 非依存）
  const activeFilter = value != null;

  const computedRange = useMemo(() => computeRange(preset), [preset]);

  function emitRange(startIso: string, endIso: string) {
    onChange?.({ start: toDate(startIso), end: toDate(endIso) });
  }

  function handlePreset(p: Preset) {
    setPreset(p);
    if (p !== "カスタム") {
      const r = computeRange(p);
      if (r) emitRange(r.start, r.end);
    }
  }

  function handleStartDate(val: string) {
    setStartDate(val);
    if (val && endDate) emitRange(val, endDate);
  }

  function handleEndDate(val: string) {
    setEndDate(val);
    if (startDate && val) emitRange(startDate, val);
  }

  const displayRange =
    preset === "カスタム"
      ? startDate && endDate
        ? `${displayDate(startDate)} 〜 ${displayDate(endDate)}`
        : null
      : computedRange
        ? `${displayDate(computedRange.start)} 〜 ${displayDate(computedRange.end)}`
        : null;

  const hasCustomRange = preset === "カスタム" && startDate && endDate;

  function handleReset() {
    setPreset("過去30日");
    setStartDate("");
    setEndDate("");
    onChange?.(null);
  }

  return (
    <div className={cn("relative flex h-full flex-col gap-1.5 px-3 py-2", className)}>
      {activeFilter && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleReset();
          }}
          className="absolute right-0.5 top-0.5 z-[1] cursor-pointer border-none bg-transparent px-1 text-xs leading-none text-[color:var(--muted-foreground)]"
          title="フィルターをリセット"
        >
          ×
        </button>
      )}
      <div className="flex items-center gap-[5px]">
        <svg
          className="h-[13px] w-[13px] flex-shrink-0 text-[color:var(--muted-foreground)]"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
          <path d="M1.5 6h13" stroke="currentColor" strokeWidth="1.25" />
          <path d="M5 1.5v2M11 1.5v2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          <circle cx="5" cy="9.5" r="0.75" fill="currentColor" />
          <circle cx="8" cy="9.5" r="0.75" fill="currentColor" />
          <circle cx="11" cy="9.5" r="0.75" fill="currentColor" />
          <circle cx="5" cy="12" r="0.75" fill="currentColor" />
          <circle cx="8" cy="12" r="0.75" fill="currentColor" />
        </svg>
        {label && (
          <span className="whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.03em] text-[color:var(--muted-foreground)]">
            {label}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-[3px]" role="group" aria-label="日付範囲プリセット">
        {PRESETS.map((p) => {
          const active = preset === p;
          return (
            <button
              key={p}
              type="button"
              className={cn(
                "cursor-pointer select-none whitespace-nowrap rounded-xl border px-[9px] py-[3px] text-[11px] font-medium leading-[1.4] transition-colors",
                active
                  ? "border-[color:var(--chart-1,#4285f4)] bg-[color:var(--chart-1,#4285f4)] text-white shadow-sm"
                  : "border-[color:var(--border)] bg-[color:var(--card)] text-[color:var(--muted-foreground)] hover:border-[color:var(--chart-1,#4285f4)] hover:text-[color:var(--chart-1,#4285f4)]",
                p === "カスタム" && !active && "border-dashed",
              )}
              onClick={() => handlePreset(p)}
              aria-pressed={active}
            >
              {p}
            </button>
          );
        })}
      </div>

      {preset === "カスタム" ? (
        <div className="flex flex-col gap-[5px]">
          <div className="flex flex-wrap items-end gap-1.5">
            <div className="flex flex-col gap-0.5">
              <label
                className="pl-px text-[10px] font-medium text-[color:var(--muted-foreground)]"
                htmlFor="filter-date-start"
              >
                開始日
              </label>
              <input
                id="filter-date-start"
                type="date"
                className="cursor-pointer rounded border border-[color:var(--border)] bg-[color:var(--card)] px-[7px] py-1 text-[11px] text-[color:var(--foreground)] outline-none transition-colors hover:border-[color:var(--chart-1,#4285f4)] focus:border-[color:var(--chart-1,#4285f4)]"
                value={startDate}
                onChange={(e) => handleStartDate(e.target.value)}
                aria-label="開始日"
              />
            </div>
            <span
              className="flex-shrink-0 pb-1.5 text-xs text-[color:var(--muted-foreground)]"
              aria-hidden="true"
            >
              〜
            </span>
            <div className="flex flex-col gap-0.5">
              <label
                className="pl-px text-[10px] font-medium text-[color:var(--muted-foreground)]"
                htmlFor="filter-date-end"
              >
                終了日
              </label>
              <input
                id="filter-date-end"
                type="date"
                className="cursor-pointer rounded border border-[color:var(--border)] bg-[color:var(--card)] px-[7px] py-1 text-[11px] text-[color:var(--foreground)] outline-none transition-colors hover:border-[color:var(--chart-1,#4285f4)] focus:border-[color:var(--chart-1,#4285f4)]"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => handleEndDate(e.target.value)}
                aria-label="終了日"
              />
            </div>
          </div>
          {hasCustomRange && (
            <div
              className="inline-flex items-center gap-[5px] self-start whitespace-nowrap rounded border border-[color:var(--chart-1,#4285f4)] bg-[color:var(--muted)] px-[9px] py-[3px] text-[11px] font-medium text-[color:var(--chart-1,#4285f4)]"
              aria-live="polite"
            >
              <svg
                className="h-[11px] w-[11px] flex-shrink-0 text-[color:var(--chart-1,#4285f4)]"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M6 3.5V6l2 1.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              {displayRange}
            </div>
          )}
        </div>
      ) : (
        displayRange && (
          <div
            className="inline-flex items-center gap-[5px] self-start whitespace-nowrap rounded border border-[color:var(--chart-1,#4285f4)] bg-[color:var(--muted)] px-[9px] py-[3px] text-[11px] font-medium text-[color:var(--chart-1,#4285f4)]"
            aria-live="polite"
          >
            <svg
              className="h-[11px] w-[11px] flex-shrink-0 text-[color:var(--chart-1,#4285f4)]"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M6 3.5V6l2 1.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            {displayRange}
          </div>
        )
      )}
    </div>
  );
}
