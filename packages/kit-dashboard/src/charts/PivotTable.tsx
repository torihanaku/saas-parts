import { useMemo, useState } from "react";
import { formatNumber } from "../lib/formatters";
import { getChartColor } from "../lib/colorUtils";
import { CHART_TEXT_MUTED } from "../lib/theme";
import { cn } from "../lib/cn";

export type PivotCellMode = "number" | "heatmap" | "bar";

export interface PivotTableProps {
  data: Record<string, Record<string, number>>;
  rows: string[];
  cols: string[];
  rowLabel?: string;
  cellMode?: PivotCellMode;
  showTotals?: boolean;
  formatter?: (v: number) => string;
  className?: string;
  /** Optional grouping: map from group name to array of row keys */
  groups?: Record<string, string[]>;
}

// --- Tailwind class fragments写像した CSS Modules（shadcn トークン参照でテーマ追従）---
const TD =
  "relative px-3 py-1.5 text-right border-b border-[color:var(--border)] " +
  "first:text-left first:font-medium first:text-[color:var(--foreground)]";
const TH =
  "px-3 py-2 text-right font-medium whitespace-nowrap bg-transparent " +
  "text-[color:var(--muted-foreground)] border-b-2 border-[color:var(--border)] " +
  "first:text-left";
const TH_TOTAL =
  "px-3 py-2 text-right font-semibold whitespace-nowrap " +
  "text-[color:var(--muted-foreground)] bg-[color:var(--card)] " +
  "border-b-2 border-[color:var(--border)]";
const TH_SORTABLE =
  "cursor-pointer select-none transition-colors " +
  "hover:bg-[color:var(--card)] hover:text-[color:var(--foreground)]";

export function PivotTable({
  data,
  rows,
  cols,
  rowLabel = "",
  cellMode = "number",
  showTotals = false,
  formatter = (v) => formatNumber(v, 0),
  className,
  groups,
}: PivotTableProps) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  function handleColClick(col: string) {
    if (sortCol === col) {
      setSortDir((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  }

  function toggleRow(key: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Determine if we are in grouped mode
  const isGrouped = groups != null && Object.keys(groups).length > 0;
  const groupNames = isGrouped ? Object.keys(groups) : [];
  const allGrouped = isGrouped
    ? groupNames.every((g) => expandedRows.has(g))
    : false;

  function toggleAllGroups() {
    if (allGrouped) {
      setExpandedRows(new Set());
    } else {
      setExpandedRows(new Set(groupNames));
    }
  }

  const sortedRows = useMemo(() => {
    if (sortCol === null) return rows;
    return [...rows].sort((a, b) => {
      const va = data[a]?.[sortCol] ?? 0;
      const vb = data[b]?.[sortCol] ?? 0;
      return sortDir === "desc" ? vb - va : va - vb;
    });
  }, [rows, data, sortCol, sortDir]);

  const { minVal, maxVal } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    rows.forEach((r) => {
      cols.forEach((c) => {
        const v = data[r]?.[c] ?? 0;
        if (v < min) min = v;
        if (v > max) max = v;
      });
    });
    return {
      minVal: min === Infinity ? 0 : min,
      maxVal: max === -Infinity ? 0 : max,
    };
  }, [data, rows, cols]);

  const range = maxVal - minVal || 1;

  const colTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    cols.forEach((c) => {
      totals[c] = rows.reduce((sum, r) => sum + (data[r]?.[c] ?? 0), 0);
    });
    return totals;
  }, [data, rows, cols]);

  const grandTotal = useMemo(
    () => cols.reduce((sum, c) => sum + (colTotals[c] ?? 0), 0),
    [colTotals, cols],
  );

  function getCellBg(value: number): string | undefined {
    if (cellMode !== "heatmap") return undefined;
    const proportion = Math.max(0, Math.min(1, (value - minVal) / range));
    const opacity = 0.08 + proportion * 0.55;
    // テーマ追従: --chart-1 を透過ミックス（DashMock は rgba(66,133,244,..) 固定だった）。
    return `color-mix(in srgb, ${getChartColor(0)} ${(opacity * 100).toFixed(
      1,
    )}%, transparent)`;
  }

  function getBarWidth(value: number): string {
    const proportion = (value - minVal) / range;
    return `${Math.round(proportion * 100)}%`;
  }

  /** Compute group subtotals for a set of row keys */
  function computeGroupSubtotals(groupRows: string[]): Record<string, number> {
    const sub: Record<string, number> = {};
    cols.forEach((c) => {
      sub[c] = groupRows.reduce((sum, r) => sum + (Number(data[r]?.[c]) || 0), 0);
    });
    return sub;
  }

  function renderDataCell(value: number, row: string, col: string) {
    const bg = getCellBg(value);
    const barW = cellMode === "bar" ? getBarWidth(value) : undefined;
    return (
      <td
        key={col}
        className={TD}
        style={{ backgroundColor: bg }}
        aria-label={`${row} ${col}: ${formatter(value)}`}
      >
        {cellMode === "bar" && (
          <span
            className="pointer-events-none absolute left-0 top-1 z-0 rounded-sm"
            style={{
              width: barW,
              height: "calc(100% - 8px)",
              background: `color-mix(in srgb, ${getChartColor(0)} 15%, transparent)`,
            }}
            aria-hidden="true"
          />
        )}
        <span className="relative z-[1]">{formatter(value)}</span>
      </td>
    );
  }

  function renderGroupedBody() {
    return groupNames.map((groupName) => {
      const groupRowKeys = (groups?.[groupName] ?? []).filter((r) =>
        rows.includes(r),
      );
      const isExpanded = expandedRows.has(groupName);
      const subtotals = computeGroupSubtotals(groupRowKeys);
      const subtotalTotal = cols.reduce(
        (sum, c) => sum + (subtotals[c] ?? 0),
        0,
      );

      // Sort within group if a sort column is active
      const sortedGroupRows =
        sortCol !== null
          ? [...groupRowKeys].sort((a, b) => {
              const va = data[a]?.[sortCol] ?? 0;
              const vb = data[b]?.[sortCol] ?? 0;
              return sortDir === "desc" ? vb - va : va - vb;
            })
          : groupRowKeys;

      return (
        <tbody key={groupName}>
          {/* Group header row */}
          <tr
            className="cursor-pointer bg-[color:var(--card)]"
            onClick={() => toggleRow(groupName)}
          >
            <td className={TD} style={{ fontWeight: 600 }}>
              <span
                className="mr-1.5 inline-block min-w-[10px] text-[10px]"
                aria-hidden="true"
              >
                {isExpanded ? "▾" : "▸"}
              </span>
              {groupName}
            </td>
            {cols.map((c) => renderDataCell(subtotals[c] ?? 0, groupName, c))}
            {showTotals && (
              <td className={cn(TD, "bg-[color:var(--muted)] font-semibold")}>
                <span className="relative z-[1]">
                  {formatter(subtotalTotal)}
                </span>
              </td>
            )}
          </tr>

          {/* Child rows (visible when expanded) */}
          {isExpanded &&
            sortedGroupRows.map((r) => {
              const rowTotal = showTotals
                ? cols.reduce((sum, c) => sum + (data[r]?.[c] ?? 0), 0)
                : 0;
              return (
                <tr key={r} className="hover:[&_td]:bg-[color:var(--card)]">
                  <td className={TD} style={{ paddingLeft: 24 }}>
                    {r}
                  </td>
                  {cols.map((c) => {
                    const value = data[r]?.[c] ?? 0;
                    return renderDataCell(value, r, c);
                  })}
                  {showTotals && (
                    <td
                      className={cn(TD, "bg-[color:var(--muted)] font-semibold")}
                    >
                      <span className="relative z-[1]">
                        {formatter(rowTotal)}
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}

          {/* Subtotal row shown only when expanded */}
          {isExpanded && (
            <tr className="bg-[color:var(--card)] [&_td]:border-t [&_td]:border-[color:var(--border)] [&_td]:font-semibold">
              <td
                className={cn(TD, "text-[11px]")}
                style={{ paddingLeft: 24, color: CHART_TEXT_MUTED }}
              >
                小計: {groupName}
              </td>
              {cols.map((c) => (
                <td key={c} className={TD}>
                  <span className="relative z-[1] font-semibold">
                    {formatter(subtotals[c] ?? 0)}
                  </span>
                </td>
              ))}
              {showTotals && (
                <td className={cn(TD, "bg-[color:var(--muted)] font-semibold")}>
                  <span className="relative z-[1]">
                    {formatter(subtotalTotal)}
                  </span>
                </td>
              )}
            </tr>
          )}
        </tbody>
      );
    });
  }

  function renderFlatBody() {
    return (
      <tbody>
        {sortedRows.map((r) => {
          const rowTotal = showTotals
            ? cols.reduce((sum, c) => sum + (data[r]?.[c] ?? 0), 0)
            : 0;

          return (
            <tr key={r} className="hover:[&_td]:bg-[color:var(--card)]">
              <td className={TD}>{r}</td>
              {cols.map((c) => {
                const value = data[r]?.[c] ?? 0;
                return renderDataCell(value, r, c);
              })}
              {showTotals && (
                <td className={cn(TD, "bg-[color:var(--muted)] font-semibold")}>
                  <span className="relative z-[1]">{formatter(rowTotal)}</span>
                </td>
              )}
            </tr>
          );
        })}
        {showTotals && (
          <tr className="[&_td]:border-t-2 [&_td]:border-[color:var(--border)] [&_td]:bg-[color:var(--muted)] [&_td]:font-bold">
            <td className={TD}>合計</td>
            {cols.map((c) => (
              <td key={c} className={TD}>
                <span className="relative z-[1]">
                  {formatter(colTotals[c] ?? 0)}
                </span>
              </td>
            ))}
            <td className={TD}>
              <span className="relative z-[1]">{formatter(grandTotal)}</span>
            </td>
          </tr>
        )}
      </tbody>
    );
  }

  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      {/* Expand/collapse all toggle for grouped mode */}
      {isGrouped && (
        <div className="flex justify-end px-2 py-1">
          <button
            onClick={toggleAllGroups}
            className="cursor-pointer rounded border border-[color:var(--border)] bg-transparent px-2 py-0.5 text-[11px] text-[color:var(--muted-foreground)]"
          >
            {allGrouped ? "全折りたたみ" : "全展開"}
          </button>
        </div>
      )}
      <table
        className="w-full border-collapse text-[13px]"
        role="grid"
        aria-label="ピボットテーブル"
      >
        <thead>
          <tr>
            <th className={TH} scope="col">
              {rowLabel}
            </th>
            {cols.map((c) => (
              <th
                key={c}
                className={cn(
                  TH,
                  TH_SORTABLE,
                  sortCol === c && "text-[color:var(--chart-1)]",
                )}
                scope="col"
                onClick={() => handleColClick(c)}
                aria-sort={
                  sortCol === c
                    ? sortDir === "desc"
                      ? "descending"
                      : "ascending"
                    : "none"
                }
              >
                {c}
                <span
                  className={cn(
                    "ml-1 inline-block align-middle text-[10px]",
                    sortCol === c ? "opacity-100" : "opacity-50",
                  )}
                  style={sortCol === c ? { color: getChartColor(0) } : undefined}
                  aria-hidden="true"
                >
                  {sortCol === c ? (sortDir === "desc" ? "▼" : "▲") : "⬍"}
                </span>
              </th>
            ))}
            {showTotals && (
              <th className={TH_TOTAL} scope="col">
                合計
              </th>
            )}
          </tr>
        </thead>
        {isGrouped ? renderGroupedBody() : renderFlatBody()}
        {/* Grand total footer for grouped mode */}
        {isGrouped && showTotals && (
          <tfoot>
            <tr className="[&_td]:border-t-2 [&_td]:border-[color:var(--border)] [&_td]:bg-[color:var(--muted)] [&_td]:font-bold">
              <td className={TD}>合計</td>
              {cols.map((c) => (
                <td key={c} className={TD}>
                  <span className="relative z-[1]">
                    {formatter(colTotals[c] ?? 0)}
                  </span>
                </td>
              ))}
              <td className={TD}>
                <span className="relative z-[1]">{formatter(grandTotal)}</span>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// Default sample data: Channel × Month × Leads
export const PIVOT_DEFAULT_ROWS = ["オーガニック", "有料広告", "イベント"];
export const PIVOT_DEFAULT_COLS = ["1月", "2月", "3月", "4月", "5月", "6月"];
export const PIVOT_DEFAULT_DATA: Record<string, Record<string, number>> = {
  オーガニック: { "1月": 120, "2月": 145, "3月": 132, "4月": 158, "5月": 174, "6月": 189 },
  有料広告: { "1月": 85, "2月": 92, "3月": 110, "4月": 103, "5月": 128, "6月": 115 },
  イベント: { "1月": 40, "2月": 35, "3月": 55, "4月": 90, "5月": 42, "6月": 68 },
};
