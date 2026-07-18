import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownProps {
  options: DropdownOption[];
  /** 単一なら string、multi なら string[]。 */
  value?: string | string[];
  onChange?: (value: string | string[]) => void;
  placeholder?: string;
  searchable?: boolean;
  multi?: boolean;
  label?: string;
  disabled?: boolean;
  className?: string;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(
        "shrink-0 transition-transform text-[color:var(--muted-foreground)]",
        open && "rotate-180",
      )}
    >
      <path
        d="M4 6L8 10L12 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Dropdown({
  options,
  value,
  onChange,
  placeholder = "選択してください",
  searchable = false,
  multi = false,
  label,
  disabled = false,
  className,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);

  // 外クリックで閉じる
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, []);

  // ESC で閉じる
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const selectedValues: string[] = multi
    ? Array.isArray(value)
      ? value
      : value != null
        ? [value]
        : []
    : value != null && !Array.isArray(value)
      ? [value]
      : [];

  const filteredOptions =
    searchable && query
      ? options.filter((o) =>
          o.label.toLowerCase().includes(query.toLowerCase()),
        )
      : options;

  function getDisplayLabel(): string {
    if (selectedValues.length === 0) return placeholder;
    if (multi) {
      if (selectedValues.length === 1) {
        return (
          options.find((o) => o.value === selectedValues[0])?.label ??
          placeholder
        );
      }
      return `${selectedValues.length}件選択中`;
    }
    return (
      options.find((o) => o.value === selectedValues[0])?.label ?? placeholder
    );
  }

  function handleOptionClick(optionValue: string) {
    if (multi) {
      const next = selectedValues.includes(optionValue)
        ? selectedValues.filter((v) => v !== optionValue)
        : [...selectedValues, optionValue];
      onChange?.(next);
    } else {
      onChange?.(optionValue);
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div
      className={cn("relative inline-flex min-w-[160px] flex-col", className)}
      ref={wrapperRef}
    >
      {label != null && (
        <div className="mb-1 text-xs font-medium text-[color:var(--muted-foreground)]">
          {label}
        </div>
      )}
      <button
        type="button"
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-left text-sm",
          "border-[color:var(--border)] bg-[color:var(--card)] text-[color:var(--foreground)]",
          "transition-colors hover:bg-[color:var(--muted)]",
          disabled && "cursor-not-allowed opacity-50",
        )}
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev);
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          className={cn(
            selectedValues.length === 0 &&
              "text-[color:var(--muted-foreground)]",
          )}
        >
          {getDisplayLabel()}
        </span>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div
          className={cn(
            "absolute left-0 top-[calc(100%+4px)] z-50 max-h-60 min-w-full overflow-y-auto rounded-md border shadow-md",
            "border-[color:var(--border)] bg-[color:var(--popover)] text-[color:var(--popover-foreground)]",
          )}
          role="listbox"
        >
          {searchable && (
            <input
              type="text"
              className={cn(
                "box-border w-full border-0 border-b px-3 py-2 text-sm outline-none",
                "border-[color:var(--border)] bg-transparent text-[color:var(--foreground)]",
              )}
              placeholder="検索..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          )}
          {filteredOptions.map((option) => {
            const isSelected = selectedValues.includes(option.value);
            return (
              <div
                key={option.value}
                className={cn(
                  "flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-sm transition-colors",
                  "hover:bg-[color:var(--muted)]",
                  isSelected
                    ? "font-medium text-[color:var(--chart-1)]"
                    : "text-[color:var(--foreground)]",
                )}
                role="option"
                aria-selected={isSelected}
                onClick={() => handleOptionClick(option.value)}
              >
                {multi && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    readOnly
                    tabIndex={-1}
                    style={{ pointerEvents: "none" }}
                  />
                )}
                {option.label}
              </div>
            );
          })}
          {filteredOptions.length === 0 && (
            <div className="px-3 py-2 text-center text-sm text-[color:var(--muted-foreground)]">
              該当なし
            </div>
          )}
        </div>
      )}
    </div>
  );
}
