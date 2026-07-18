import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

export interface DateRange {
  start: Date;
  end: Date;
}

export interface DateRangePickerProps {
  value?: DateRange;
  onChange?: (range: DateRange) => void;
  className?: string;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isInRange(date: Date, start: Date, end: Date): boolean {
  return date >= start && date <= end;
}

export function DateRangePicker({
  value,
  onChange,
  className,
}: DateRangePickerProps) {
  const today = new Date();
  const defaultRange: DateRange = {
    start: new Date(today.getFullYear(), today.getMonth(), 1),
    end: today,
  };
  const [range, setRange] = useState<DateRange>(value ?? defaultRange);
  const [open, setOpen] = useState(false);
  const [selecting, setSelecting] = useState<"start" | "end">("start");
  const [viewDate, setViewDate] = useState(
    new Date(range.start.getFullYear(), range.start.getMonth(), 1),
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function selectDay(date: Date) {
    if (selecting === "start") {
      const newRange = { start: date, end: date };
      setRange(newRange);
      setSelecting("end");
    } else {
      const newRange =
        date >= range.start
          ? { start: range.start, end: date }
          : { start: date, end: range.start };
      setRange(newRange);
      setSelecting("start");
      setOpen(false);
      onChange?.(newRange);
    }
  }

  function applyPreset(start: Date, end: Date) {
    const newRange = { start, end };
    setRange(newRange);
    setOpen(false);
    onChange?.(newRange);
  }

  // 月のカレンダーグリッドを生成
  function getDays(): (Date | null)[] {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days: (Date | null)[] = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let d = 1; d <= daysInMonth; d++) days.push(new Date(year, month, d));
    return days;
  }

  const presets = [
    { label: "今日", fn: () => applyPreset(today, today) },
    {
      label: "過去7日",
      fn: () => {
        const s = new Date(today);
        s.setDate(today.getDate() - 6);
        applyPreset(s, today);
      },
    },
    {
      label: "過去30日",
      fn: () => {
        const s = new Date(today);
        s.setDate(today.getDate() - 29);
        applyPreset(s, today);
      },
    },
    {
      label: "今月",
      fn: () =>
        applyPreset(new Date(today.getFullYear(), today.getMonth(), 1), today),
    },
    {
      label: "前月",
      fn: () => {
        const s = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const e = new Date(today.getFullYear(), today.getMonth(), 0);
        applyPreset(s, e);
      },
    },
  ];

  const days = getDays();

  return (
    <div
      className={cn("relative inline-block", className)}
      ref={ref}
    >
      <button
        type="button"
        className={cn(
          "flex items-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-1.5 text-sm",
          "border-[color:var(--border)] bg-[color:var(--card)] text-[color:var(--foreground)]",
          "cursor-pointer transition-colors hover:bg-[color:var(--muted)]",
        )}
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        {formatDate(range.start)} 〜 {formatDate(range.end)}
      </button>
      {open && (
        <div
          className={cn(
            "absolute left-0 top-[calc(100%+4px)] z-[100] min-w-[280px] rounded-md border shadow-lg",
            "border-[color:var(--border)] bg-[color:var(--popover)] text-[color:var(--popover-foreground)]",
          )}
        >
          <div className="flex flex-wrap gap-1 border-b border-[color:var(--border)] p-2">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                className={cn(
                  "cursor-pointer rounded-full border px-2.5 py-[3px] text-xs transition-colors",
                  "border-[color:var(--border)] bg-[color:var(--card)]",
                  "hover:border-[color:var(--chart-1)] hover:bg-[color:var(--chart-1)] hover:text-white",
                )}
                onClick={p.fn}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between px-3 py-2">
            <button
              type="button"
              className="cursor-pointer rounded-sm border-0 bg-transparent px-2 py-1 text-base text-[color:var(--muted-foreground)] hover:bg-[color:var(--muted)]"
              onClick={() =>
                setViewDate(
                  new Date(
                    viewDate.getFullYear(),
                    viewDate.getMonth() - 1,
                    1,
                  ),
                )
              }
            >
              ‹
            </button>
            <span className="text-sm font-medium">
              {viewDate.getFullYear()}年{viewDate.getMonth() + 1}月
            </span>
            <button
              type="button"
              className="cursor-pointer rounded-sm border-0 bg-transparent px-2 py-1 text-base text-[color:var(--muted-foreground)] hover:bg-[color:var(--muted)]"
              onClick={() =>
                setViewDate(
                  new Date(
                    viewDate.getFullYear(),
                    viewDate.getMonth() + 1,
                    1,
                  ),
                )
              }
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-7 px-2">
            {["日", "月", "火", "水", "木", "金", "土"].map((d) => (
              <span
                key={d}
                className="p-1 text-center text-xs text-[color:var(--muted-foreground)]"
              >
                {d}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 px-2 pb-2 pt-1">
            {days.map((date, i) => {
              if (!date) return <span key={i} />;
              const isStart = isSameDay(date, range.start);
              const isEnd = isSameDay(date, range.end);
              const inRange = isInRange(date, range.start, range.end);
              const isToday = isSameDay(date, today);
              const isEdge = isStart || isEnd;
              const midRange = !isStart && !isEnd && inRange;
              return (
                <button
                  key={i}
                  type="button"
                  className={cn(
                    "cursor-pointer border-0 px-0.5 py-1.5 text-center text-sm transition-colors",
                    !isEdge && "hover:bg-[color:var(--muted)]",
                    isEdge
                      ? "rounded-full bg-[color:var(--chart-1)] font-medium text-white"
                      : "bg-transparent",
                    midRange &&
                      "bg-[color:color-mix(in_srgb,var(--chart-1)_15%,transparent)]",
                    isToday &&
                      !isEdge &&
                      "font-bold text-[color:var(--chart-1)]",
                  )}
                  onClick={() => selectDay(date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
