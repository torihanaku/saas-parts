import { useMemo, useState } from "react";
import { cn } from "../lib/cn";
import { CHART_TEXT_MUTED } from "../lib/theme";

export interface FilterCheckboxWidgetProps {
  label?: string;
  /** 選択肢。string[] を第一に、後方互換で改行区切り string も受ける。 */
  options?: string[] | string;
  /** 制御値（チェック済みの値の配列）。 */
  value?: string[];
  /** 非制御時の初期チェック。 */
  defaultValue?: string[];
  /** チェック変更。チェック済みの全値を通知（空配列＝リセット）。 */
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

const DEFAULT_OPTIONS = "オプションA\nオプションB\nオプションC\nオプションD";

export function FilterCheckboxWidget({
  label = "フィルター",
  options = DEFAULT_OPTIONS,
  value,
  defaultValue,
  onChange,
  className,
}: FilterCheckboxWidgetProps) {
  const optionList = useMemo(() => normalizeOptions(options), [options]);
  const isControlled = value !== undefined;

  const [internal, setInternal] = useState<string[]>(defaultValue ?? []);
  const checkedValues = isControlled ? value! : internal;
  const checkedSet = useMemo(() => new Set(checkedValues), [checkedValues]);

  const commit = (next: string[]) => {
    if (!isControlled) setInternal(next);
    onChange?.(next);
  };

  const toggle = (opt: string) => {
    const next = checkedSet.has(opt)
      ? checkedValues.filter((v) => v !== opt)
      : [...checkedValues, opt];
    commit(next);
  };

  const handleReset = () => commit([]);

  const hasActiveFilter = checkedValues.length > 0;

  return (
    <div
      className={cn(
        "relative flex flex-col gap-1.5 px-3 py-2 h-full overflow-auto",
        className,
      )}
    >
      {hasActiveFilter && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleReset();
          }}
          className="absolute top-0.5 right-0.5 z-[1] cursor-pointer border-0 bg-transparent px-1 text-xs leading-none"
          style={{ color: CHART_TEXT_MUTED }}
          title="フィルターをリセット"
        >
          ×
        </button>
      )}
      {label && (
        <span className="text-xs font-medium whitespace-nowrap text-[color:var(--muted-foreground)]">
          {label}
        </span>
      )}
      <div className="flex flex-col gap-1">
        {optionList.map((opt) => (
          <label
            key={opt}
            className="group flex cursor-pointer items-center gap-1.5"
          >
            <input
              type="checkbox"
              className="h-[13px] w-[13px] flex-shrink-0 cursor-pointer accent-[var(--chart-1)]"
              checked={checkedSet.has(opt)}
              onChange={() => toggle(opt)}
            />
            <span className="select-none text-xs text-[color:var(--foreground)] group-hover:text-[color:var(--chart-1)]">
              {opt}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
