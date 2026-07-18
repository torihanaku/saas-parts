import { useMemo, useState } from "react";
import { cn } from "../lib/cn";

export interface FilterListWidgetProps {
  label?: string;
  /** 選択肢。string[] を第一に、後方互換で改行区切り string も受ける。 */
  options?: string[] | string;
  /** 制御値（選択済みの値の配列）。 */
  value?: string[];
  /** 非制御時の初期選択。 */
  defaultValue?: string[];
  /** 複数選択を許可。false（既定）は単一選択（同一クリックで解除）。 */
  multi?: boolean;
  /** 選択変更。選択済みの全値を通知（空配列＝リセット）。 */
  onChange?: (values: string[]) => void;
  className?: string;
}

function normalizeOptions(options: string[] | string): string[] {
  if (Array.isArray(options)) {
    return options.map((o) => o.trim()).filter(Boolean);
  }
  return options
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean);
}

const DEFAULT_OPTIONS = "すべて\n東京\n大阪\n名古屋\n福岡\n札幌\n仙台\n広島";

export function FilterListWidget({
  label = "フィルター",
  options = DEFAULT_OPTIONS,
  value,
  defaultValue,
  multi = false,
  onChange,
  className,
}: FilterListWidgetProps) {
  const optionList = useMemo(() => normalizeOptions(options), [options]);
  const isControlled = value !== undefined;

  const [internal, setInternal] = useState<string[]>(defaultValue ?? []);
  const selectedValues = isControlled ? value! : internal;
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);

  const commit = (next: string[]) => {
    if (!isControlled) setInternal(next);
    onChange?.(next);
  };

  const toggle = (opt: string) => {
    if (multi) {
      const next = selectedSet.has(opt)
        ? selectedValues.filter((v) => v !== opt)
        : [...selectedValues, opt];
      commit(next);
    } else {
      commit(selectedSet.has(opt) ? [] : [opt]);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 px-3 py-2 h-full overflow-hidden",
        className,
      )}
    >
      {label && (
        <span className="flex-shrink-0 text-xs font-medium whitespace-nowrap text-[color:var(--muted-foreground)]">
          {label}
        </span>
      )}
      <ul className="m-0 flex-1 list-none overflow-y-auto rounded border border-[color:var(--border)] bg-[color:var(--card)] p-0">
        {optionList.map((opt) => {
          const isSelected = selectedSet.has(opt);
          return (
            <li
              key={opt}
              onClick={() => toggle(opt)}
              className={cn(
                "cursor-pointer select-none border-b border-[color:var(--border)] px-2.5 py-[5px] text-xs last:border-b-0",
                isSelected
                  ? "bg-[color:var(--accent)] font-medium text-[color:var(--chart-1)]"
                  : "text-[color:var(--foreground)] hover:bg-[color:var(--accent)] hover:text-[color:var(--chart-1)]",
              )}
            >
              {opt}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
