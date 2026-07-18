import { useState } from "react";
import { cn } from "../lib/cn";

export interface FilterSliderWidgetProps {
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  /** 制御値。指定時はこの値を表示（消費側で状態管理）。 */
  value?: number;
  /** 非制御時の初期値。未指定なら min。 */
  defaultValue?: number;
  /** つまみ操作確定時（pointer/mouse up）に呼ばれる。 */
  onChange?: (value: number) => void;
  className?: string;
}

/**
 * 数値レンジのスライダーフィルター。store 非依存の制御/非制御両対応。
 * `value` を渡せば制御コンポーネント、渡さなければ内部 state で動く。
 * 確定（pointer/mouse up）時に `onChange(value)` を呼ぶ。
 */
export function FilterSliderWidget({
  label = "数値フィルター",
  min = 0,
  max = 100,
  step = 1,
  value,
  defaultValue,
  onChange,
  className,
}: FilterSliderWidgetProps) {
  const isControlled = value !== undefined;
  const [internal, setInternal] = useState<number>(defaultValue ?? min);
  const current = isControlled ? value! : internal;

  const commit = () => {
    onChange?.(current);
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
      <div className="flex items-center gap-2">
        <span className="flex-shrink-0 whitespace-nowrap text-[11px] text-[color:var(--muted-foreground)]">
          最小: {min}
        </span>
        <input
          type="range"
          className="h-1 min-w-0 flex-1 cursor-pointer rounded-sm border-none bg-[color:var(--border)] outline-none [accent-color:var(--chart-1,#4285f4)]"
          min={min}
          max={max}
          step={step}
          value={current}
          onChange={(e) => {
            if (!isControlled) setInternal(Number(e.target.value));
            else onChange?.(Number(e.target.value));
          }}
          onPointerUp={commit}
          onMouseUp={commit}
        />
        <span className="flex-shrink-0 whitespace-nowrap text-[11px] text-[color:var(--muted-foreground)]">
          {max}
        </span>
      </div>
      <div className="text-center text-xl font-semibold leading-none text-[color:var(--chart-1,#4285f4)]">
        {current}
      </div>
    </div>
  );
}
