import { useState } from "react";
import { cn } from "../lib/cn";
import { CHART_TEXT_MUTED } from "../lib/theme";

export interface FilterDropdownWidgetProps {
  label?: string;
  /** 選択肢。string[] を第一に、後方互換で改行区切り string も受ける。 */
  options?: string[] | string;
  /** 制御値。"すべて"/"all"/"" は未選択（null）扱い。 */
  value?: string;
  /** 非制御時の初期値。 */
  defaultValue?: string;
  /** 選択変更。未選択（すべて/リセット）は null で通知。 */
  onChange?: (value: string | null) => void;
  /**
   * 任意のカスケード。親フィルタの選択値 (`parentValue`) に一致するキーがあれば、
   * その子選択肢に options を差し替える。既定は無効（app 固有デモデータは削除済み）。
   */
  childOptions?: Record<string, string[]>;
  /** カスケード用の親フィルタ選択値。 */
  parentValue?: string;
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

function isAllValue(v: string): boolean {
  return v === "all" || v === "すべて" || v === "";
}

export function FilterDropdownWidget({
  label = "フィルター",
  options = [],
  value,
  defaultValue,
  onChange,
  childOptions,
  parentValue,
  className,
}: FilterDropdownWidgetProps) {
  const [internal, setInternal] = useState(defaultValue || "all");
  const isControlled = value !== undefined;
  const selected = isControlled ? value || "all" : internal;

  const allOptions = normalizeOptions(options);

  // 任意カスケード: 親選択値に一致する子選択肢があれば差し替える。
  let optionList = allOptions;
  if (childOptions && parentValue) {
    const children = childOptions[parentValue];
    if (children && children.length > 0) {
      optionList = children;
    }
  }

  const commit = (newValue: string) => {
    if (!isControlled) setInternal(newValue);
    onChange?.(isAllValue(newValue) ? null : newValue);
  };

  const hasActiveFilter = !isAllValue(selected);

  return (
    <div
      className={cn("relative flex items-center gap-2 px-3 py-2 h-full", className)}
    >
      {hasActiveFilter && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            commit("all");
          }}
          className="absolute top-0.5 right-0.5 z-[1] cursor-pointer border-0 bg-transparent px-1 text-xs leading-none"
          style={{ color: CHART_TEXT_MUTED }}
          title="フィルターをリセット"
        >
          ×
        </button>
      )}
      {label && (
        <span
          className="text-xs font-medium whitespace-nowrap text-[color:var(--muted-foreground)]"
        >
          {label}
        </span>
      )}
      <select
        className={cn(
          "flex-1 max-w-full cursor-pointer rounded outline-none px-2 py-1 text-xs",
          "border border-[color:var(--border)]",
          "bg-[color:var(--card)] text-[color:var(--foreground)]",
          "hover:border-[color:var(--chart-1)] focus:border-[color:var(--chart-1)]",
        )}
        value={selected}
        onChange={(e) => commit(e.target.value)}
      >
        <option value="all">すべて</option>
        {optionList.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}
