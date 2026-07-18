import { useState } from "react";
import { cn } from "../lib/cn";
import { DateRangePicker, type DateRange } from "./DateRangePicker";
import { Dropdown, type DropdownOption } from "../primitives/Dropdown";

export interface FilterBarFilter {
  key: string;
  label?: string;
  options: DropdownOption[];
  multi?: boolean;
}

export interface FilterBarProps {
  filters?: FilterBarFilter[];
  showDateRange?: boolean;
  onFilterChange?: (key: string, value: string | string[]) => void;
  onDateRangeChange?: (start: Date, end: Date) => void;
  className?: string;
}

/**
 * presentational なフィルタ列。状態は各 Dropdown のローカル制御値のみで、
 * 変更は onFilterChange / onDateRangeChange で消費側へ通知する（injection 式）。
 */
export function FilterBar({
  filters = [],
  showDateRange = true,
  onFilterChange,
  onDateRangeChange,
  className,
}: FilterBarProps) {
  const [values, setValues] = useState<Record<string, string | string[]>>({});

  function handleChange(key: string, value: string | string[]) {
    setValues((v) => ({ ...v, [key]: value }));
    onFilterChange?.(key, value);
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-end gap-3 py-3",
        className,
      )}
    >
      {showDateRange && (
        <div>
          <DateRangePicker
            onChange={(range: DateRange) =>
              onDateRangeChange?.(range.start, range.end)
            }
          />
        </div>
      )}
      {filters.map((f) => (
        <div key={f.key}>
          <Dropdown
            label={f.label}
            options={f.options}
            value={values[f.key]}
            multi={f.multi}
            searchable
            onChange={(v) => handleChange(f.key, v)}
          />
        </div>
      ))}
    </div>
  );
}
