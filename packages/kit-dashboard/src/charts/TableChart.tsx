import { useState, useMemo, useEffect, useCallback } from "react";
import { useSort } from "../lib/useSort";
import { formatNumber } from "../lib/formatters";
import { getChartColor } from "../lib/colorUtils";
import { cn } from "../lib/cn";

export interface TableColumn {
  key: string;
  label: string;
  type: "string" | "number" | "percent" | "date";
  sortable?: boolean;
  width?: number;
  align?: "left" | "right" | "center";
}

export interface ConditionalRule {
  column: string;
  type: "color-scale" | "threshold";
  thresholds?: { value: number; color: string; bgColor: string }[];
}

export interface TableChartProps {
  columns: TableColumn[];
  data: Record<string, string | number>[];
  striped?: boolean;
  stickyHeader?: boolean;
  defaultSortKey?: string;
  defaultSortDir?: "asc" | "desc";
  maxRows?: number;
  className?: string;
  pagination?: number;
  searchable?: boolean;
  conditionalFormatting?: ConditionalRule[];
  cellVisualization?: Record<string, "bar">;
  sortOrder?: "none" | "asc" | "desc";
  limitRows?: number;
  conditionalFormat?: "none" | "row" | "cell";
  showTotalRow?: boolean;
  stickyFirstColumn?: boolean;
  cellHeatmap?: string[];
  expandableRows?: boolean;
  secondarySortKey?: string;
  secondarySortDir?: "asc" | "desc";
  columnRules?: Record<
    string,
    Array<{ threshold: number; operator: string; color: string }>
  >;
}

// --- CSS Modules → Tailwind + shadcn トークン写像（テーマ追従）---
const WRAPPER =
  "overflow-auto rounded-lg shadow-sm border border-[color:var(--border)]";
const TABLE = "w-full border-collapse";
const THEAD_TH =
  "px-4 py-3 text-[11px] font-medium whitespace-nowrap select-none " +
  "text-[color:var(--muted-foreground)] bg-[color:var(--muted)] " +
  "border-b-2 border-[color:var(--border)]";
const TH = "relative select-none overflow-hidden";
const TH_SORTABLE =
  "cursor-pointer hover:bg-[color:var(--accent)] hover:text-[color:var(--foreground)]";
const TD =
  "px-4 py-2.5 text-[13px] border-b border-[color:var(--border)] text-[color:var(--foreground)]";
const RESIZE_HANDLE =
  "absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent z-[2] " +
  "hover:bg-[color:var(--border)]";
const FOOTER =
  "px-4 py-2 text-[11px] text-[color:var(--muted-foreground)] " +
  "border-t border-[color:var(--border)] bg-[color:var(--muted)]";
const SEARCH_ROW = "p-2 border-b border-[color:var(--border)]";
const SEARCH_INPUT =
  "w-full box-border rounded px-2.5 py-1.5 text-[13px] outline-none " +
  "border border-[color:var(--border)] bg-[color:var(--card)] " +
  "text-[color:var(--foreground)] focus:border-[color:var(--ring)]";
const PAGINATION =
  "flex items-center justify-end gap-2 px-3 py-2 text-[12px] " +
  "text-[color:var(--muted-foreground)] border-t border-[color:var(--border)]";
const PAGE_BTN =
  "rounded border border-[color:var(--border)] px-2 py-0.5 text-[12px] cursor-pointer " +
  "disabled:opacity-40 disabled:cursor-default hover:enabled:bg-[color:var(--muted)]";

function formatCell(value: string | number, type: TableColumn["type"]): string {
  if (value === null || value === undefined) return "";
  if (type === "number" && typeof value === "number") return formatNumber(value);
  if (type === "percent" && typeof value === "number") {
    // Values are expected as fractions (0.85 = 85%) — multiply by 100 to display
    return `${(value * 100).toFixed(1)}%`;
  }
  return String(value);
}

function resolveAlign(col: TableColumn): "left" | "right" | "center" {
  if (col.align) return col.align;
  if (col.type === "number" || col.type === "percent") return "right";
  return "left";
}

/** 白→チャート色1 の色スケール（テーマ追従: --chart-1 を透過ミックス）。 */
function chartScaleBg(t: number): string {
  const pct = Math.max(0, Math.min(1, t));
  return `color-mix(in srgb, ${getChartColor(0)} ${(pct * 30).toFixed(
    1,
  )}%, transparent)`;
}

function getAutoStatusColor(
  value: number,
  colType: TableColumn["type"],
  maxVal: number,
): string | null {
  const good = "color-mix(in srgb, var(--chart-positive) 18%, transparent)";
  const warn = "color-mix(in srgb, var(--chart-warning) 22%, transparent)";
  const bad = "color-mix(in srgb, var(--chart-negative) 15%, transparent)";
  if (colType === "percent") {
    if (value >= 0.7) return good;
    if (value >= 0.4) return warn;
    return bad;
  }
  if (colType === "number" && maxVal > 0) {
    const t = value / maxVal;
    if (t >= 0.7) return good;
    if (t >= 0.4) return warn;
    return bad;
  }
  return null;
}

function getColumnRuleColor(
  colKey: string,
  value: string | number,
  columnRules?: Record<
    string,
    Array<{ threshold: number; operator: string; color: string }>
  >,
): string | undefined {
  const rules = columnRules?.[colKey];
  if (!rules) return undefined;
  const v = Number(value);
  for (const rule of rules) {
    if (rule.operator === ">=" && v >= rule.threshold) return rule.color;
    if (rule.operator === "<=" && v <= rule.threshold) return rule.color;
    if (rule.operator === ">" && v > rule.threshold) return rule.color;
    if (rule.operator === "<" && v < rule.threshold) return rule.color;
  }
  return undefined;
}

export function TableChart({
  columns,
  data,
  striped = false,
  stickyHeader = false,
  defaultSortKey,
  defaultSortDir = "asc",
  maxRows,
  className,
  pagination,
  searchable,
  conditionalFormatting,
  cellVisualization,
  sortOrder,
  limitRows,
  conditionalFormat = "none",
  showTotalRow = false,
  stickyFirstColumn = false,
  cellHeatmap,
  expandableRows = false,
  secondarySortKey,
  secondarySortDir = "asc",
  columnRules,
}: TableChartProps) {
  const {
    sorted: baseSorted,
    sortKey,
    sortDir,
    toggle,
  } = useSort(data, defaultSortKey, defaultSortDir);

  // Apply secondary sort when primary sort values are equal
  const sorted = useMemo(() => {
    if (!secondarySortKey) return baseSorted;
    return [...baseSorted].sort((a, b) => {
      const va = a[secondarySortKey] ?? "";
      const vb = b[secondarySortKey] ?? "";
      const diff2 =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb));
      return secondarySortDir === "desc" ? -diff2 : diff2;
    });
  }, [baseSorted, secondarySortKey, secondarySortDir]);

  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [colWidths, setColWidths] = useState<number[]>(() =>
    columns.map(() => 120),
  );
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [copiedCell, setCopiedCell] = useState<string | null>(null);

  const toggleColumn = (colKey: string) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(colKey)) next.delete(colKey);
      else next.add(colKey);
      return next;
    });
  };

  const toggleRow = (rowIdx: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowIdx)) next.delete(rowIdx);
      else next.add(rowIdx);
      return next;
    });
  };

  // Reinitialize colWidths when the number of columns changes
  useEffect(() => {
    setColWidths((prev) => {
      if (prev.length === columns.length) return prev;
      return columns.map((_, i) => prev[i] ?? 120);
    });
  }, [columns.length]);

  // Reset row selection when data changes (e.g. filter applied)
  useEffect(() => {
    setSelectedRow(null);
  }, [data]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, colIndex: number) => {
      const startX = e.clientX;
      const startWidth = colWidths[colIndex]!;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const diff = moveEvent.clientX - startX;
        const newWidth = Math.max(50, startWidth + diff);
        setColWidths((prev) =>
          prev.map((w, i) => (i === colIndex ? newWidth : w)),
        );
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    },
    [colWidths],
  );

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return sorted;
    const q = searchQuery.toLowerCase();
    return sorted.filter((row) =>
      columns.some((col) =>
        String(row[col.key] ?? "")
          .toLowerCase()
          .includes(q),
      ),
    );
  }, [sorted, searchQuery, columns]);

  // Apply sortOrder and limitRows (applied after useSort/filter, before pagination)
  const firstNumericKey = columns.find(
    (c) => c.type === "number" || c.type === "percent",
  )?.key;
  const sortedAndLimited = useMemo(() => {
    let rows = [...filtered];
    if (sortOrder === "asc" || sortOrder === "desc") {
      rows.sort((a, b) => {
        const aVal =
          firstNumericKey != null
            ? typeof a[firstNumericKey] === "number"
              ? (a[firstNumericKey] as number)
              : Number(a[firstNumericKey] ?? 0)
            : 0;
        const bVal =
          firstNumericKey != null
            ? typeof b[firstNumericKey] === "number"
              ? (b[firstNumericKey] as number)
              : Number(b[firstNumericKey] ?? 0)
            : 0;
        return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
      });
    }
    if (limitRows != null && limitRows > 0) rows = rows.slice(0, limitRows);
    return rows;
  }, [filtered, sortOrder, limitRows, firstNumericKey]);

  const pageSize = pagination ?? maxRows;
  const totalRows = sortedAndLimited.length;
  const totalPages = pageSize ? Math.ceil(totalRows / pageSize) : 1;
  const displayRows = pageSize
    ? sortedAndLimited.slice(
        (currentPage - 1) * pageSize,
        currentPage * pageSize,
      )
    : sortedAndLimited;

  // Precompute column max values for bar/color-scale
  const colMaxMap = useMemo(() => {
    const m: Record<string, number> = {};
    columns.forEach((col) => {
      if (col.type === "number" || col.type === "percent") {
        m[col.key] = Math.max(...data.map((r) => Number(r[col.key] ?? 0)));
      }
    });
    return m;
  }, [data, columns]);

  const colMinMap = useMemo(() => {
    const m: Record<string, number> = {};
    columns.forEach((col) => {
      if (col.type === "number" || col.type === "percent") {
        m[col.key] = Math.min(...data.map((r) => Number(r[col.key] ?? 0)));
      }
    });
    return m;
  }, [data, columns]);

  // M-4: Heatmap min/max per column
  const heatmapMinMap = useMemo(() => {
    const m: Record<string, number> = {};
    if (!cellHeatmap) return m;
    cellHeatmap.forEach((key) => {
      m[key] = Math.min(...data.map((r) => Number(r[key] ?? 0)));
    });
    return m;
  }, [data, cellHeatmap]);

  const heatmapMaxMap = useMemo(() => {
    const m: Record<string, number> = {};
    if (!cellHeatmap) return m;
    cellHeatmap.forEach((key) => {
      m[key] = Math.max(...data.map((r) => Number(r[key] ?? 0)));
    });
    return m;
  }, [data, cellHeatmap]);

  function getCellStyle(
    col: TableColumn,
    value: string | number,
  ): React.CSSProperties {
    if (!conditionalFormatting) return {};
    const rule = conditionalFormatting.find((r) => r.column === col.key);
    if (!rule) return {};
    const num = typeof value === "number" ? value : Number(value);
    if (rule.type === "color-scale") {
      const min = colMinMap[col.key] ?? 0;
      const max = colMaxMap[col.key] ?? 1;
      const t = max > min ? (num - min) / (max - min) : 0;
      return { background: chartScaleBg(t) };
    }
    if (rule.type === "threshold" && rule.thresholds) {
      const matched = [...rule.thresholds]
        .reverse()
        .find((t) => num >= t.value);
      if (matched) return { color: matched.color, background: matched.bgColor };
    }
    return {};
  }

  function getHeatmapStyle(
    colKey: string,
    value: string | number,
  ): React.CSSProperties {
    if (!cellHeatmap?.includes(colKey)) return {};
    const num = typeof value === "number" ? value : Number(value);
    const min = heatmapMinMap[colKey] ?? 0;
    const max = heatmapMaxMap[colKey] ?? 1;
    const t = max > min ? (num - min) / (max - min) : 0;
    return { background: chartScaleBg(t) };
  }

  // H-2: Compute total row values
  const totalRowValues = useMemo(() => {
    if (!showTotalRow) return null;
    const totals: Record<string, string | number> = {};
    columns.forEach((col) => {
      if (col.type === "number" || col.type === "percent") {
        const sum = data.reduce(
          (acc, row) =>
            acc +
            (typeof row[col.key] === "number"
              ? (row[col.key] as number)
              : Number(row[col.key] ?? 0)),
          0,
        );
        totals[col.key] = sum;
      } else {
        totals[col.key] = col === columns[0] ? "合計" : "";
      }
    });
    return totals;
  }, [showTotalRow, columns, data]);

  // sticky 用の背景/罫線トークン（インライン style 併用が必要な箇所）
  const stickyBg = "var(--card)";
  const stickyBorder = "2px solid var(--border)";
  const mutedBg = "var(--muted)";

  return (
    <div className={cn(WRAPPER, className)}>
      {searchable && (
        <div className={SEARCH_ROW}>
          <input
            className={SEARCH_INPUT}
            placeholder="検索..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setCurrentPage(1);
            }}
          />
        </div>
      )}
      <table
        className={cn(
          TABLE,
          striped && "[&_tbody_tr:nth-child(odd)_td]:bg-[color:var(--muted)]",
        )}
      >
        <thead>
          <tr>
            {/* L-4: expand toggle column header */}
            {expandableRows && (
              <th
                className={cn(THEAD_TH, TH)}
                style={{ width: 32, minWidth: 32, padding: "0 4px" }}
              />
            )}
            {columns.map((col, colIndex) => {
              const isSorted = sortKey === col.key;
              const align = resolveAlign(col);
              const isHidden = hiddenCols.has(col.key);
              // M-3: sticky first column style for th
              const isFirstVisible = !expandableRows && colIndex === 0;
              const stickyFirstStyle: React.CSSProperties =
                stickyFirstColumn && isFirstVisible
                  ? {
                      position: "sticky",
                      left: 0,
                      background: stickyBg,
                      zIndex: 2,
                      borderRight: stickyBorder,
                    }
                  : {};
              if (isHidden) {
                return (
                  <th
                    key={col.key}
                    className={cn(THEAD_TH, TH)}
                    style={{
                      width: 28,
                      minWidth: 28,
                      padding: "0 2px",
                      background: mutedBg,
                      ...stickyFirstStyle,
                    }}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleColumn(col.key);
                      }}
                      className="cursor-pointer border-none bg-transparent p-0.5 text-[10px] opacity-50"
                      title={`${col.label} を表示`}
                    >
                      👁
                    </button>
                  </th>
                );
              }
              return (
                <th
                  key={col.key}
                  className={cn(THEAD_TH, TH, col.sortable && TH_SORTABLE)}
                  style={{
                    width: col.width != null ? col.width : colWidths[colIndex],
                    minWidth: colWidths[colIndex],
                    textAlign: align,
                    position: stickyHeader
                      ? "sticky"
                      : stickyFirstColumn && isFirstVisible
                        ? "sticky"
                        : "relative",
                    top: stickyHeader ? 0 : undefined,
                    zIndex: stickyHeader
                      ? 2
                      : stickyFirstColumn && isFirstVisible
                        ? 2
                        : undefined,
                    left:
                      stickyFirstColumn && isFirstVisible ? 0 : undefined,
                    background:
                      stickyFirstColumn && isFirstVisible
                        ? stickyBg
                        : undefined,
                    borderRight:
                      stickyFirstColumn && isFirstVisible
                        ? stickyBorder
                        : undefined,
                  }}
                  onClick={
                    col.sortable
                      ? () => {
                          toggle(col.key);
                          setCurrentPage(1);
                        }
                      : undefined
                  }
                  aria-sort={
                    isSorted
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  <div className="flex items-center gap-1">
                    <span className="flex-1">{col.label}</span>
                    {col.sortable && (
                      <span style={{ opacity: isSorted ? 1 : 0.3 }}>
                        {isSorted ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                      </span>
                    )}
                    {col.key === sortKey && (
                      <span
                        className="text-[10px] font-bold"
                        style={{ color: getChartColor(0) }}
                      >
                        ①{sortDir === "asc" ? "↑" : "↓"}
                      </span>
                    )}
                    {col.key === secondarySortKey && (
                      <span
                        className="text-[10px] font-bold"
                        style={{ color: getChartColor(1) }}
                      >
                        ②{secondarySortDir === "asc" ? "↑" : "↓"}
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleColumn(col.key);
                      }}
                      className="cursor-pointer border-none bg-transparent px-0.5 text-[10px] leading-none opacity-40"
                      title={`${col.label} を非表示`}
                    >
                      👁
                    </button>
                  </div>
                  <div
                    className={RESIZE_HANDLE}
                    onMouseDown={(e) => handleResizeStart(e, colIndex)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, rowIdx) => {
            // Compute auto conditional format color for this row
            const autoColorCol =
              conditionalFormat !== "none"
                ? columns.find(
                    (c) => c.type === "percent" || c.type === "number",
                  )
                : null;
            const autoColor = autoColorCol
              ? getAutoStatusColor(
                  typeof row[autoColorCol.key] === "number"
                    ? (row[autoColorCol.key] as number)
                    : Number(row[autoColorCol.key] ?? 0),
                  autoColorCol.type,
                  colMaxMap[autoColorCol.key] ?? 1,
                )
              : null;
            const rowBg =
              conditionalFormat === "row" && autoColor ? autoColor : undefined;
            const isExpanded = expandedRows.has(rowIdx);
            const selectedBg =
              "color-mix(in srgb, var(--chart-1) 12%, transparent)";

            return (
              <>
                <tr
                  key={`row-${rowIdx}`}
                  className="cursor-pointer"
                  style={{
                    background:
                      selectedRow === rowIdx
                        ? selectedBg
                        : (rowBg ?? undefined),
                  }}
                  onClick={() =>
                    setSelectedRow(selectedRow === rowIdx ? null : rowIdx)
                  }
                >
                  {/* L-4: expand toggle button cell */}
                  {expandableRows && (
                    <td
                      className={TD}
                      style={{
                        width: 32,
                        minWidth: 32,
                        textAlign: "center",
                        padding: "0 4px",
                      }}
                    >
                      <button
                        onClick={() => toggleRow(rowIdx)}
                        className="cursor-pointer border-none bg-transparent p-0.5 text-[12px]"
                        aria-label={isExpanded ? "折りたたむ" : "展開する"}
                      >
                        {isExpanded ? "▼" : "▶"}
                      </button>
                    </td>
                  )}
                  {columns.map((col, colIndex) => {
                    if (hiddenCols.has(col.key)) {
                      return (
                        <td
                          key={col.key}
                          className={TD}
                          style={{
                            width: 28,
                            minWidth: 28,
                            padding: 0,
                            background: mutedBg,
                          }}
                        />
                      );
                    }
                    const raw = row[col.key];
                    const align = resolveAlign(col);
                    const isBar = cellVisualization?.[col.key] === "bar";
                    const numVal = typeof raw === "number" ? raw : Number(raw);
                    const maxVal = colMaxMap[col.key] ?? 1;
                    const barPct = maxVal > 0 ? (numVal / maxVal) * 100 : 0;
                    const cellStyle = getCellStyle(col, raw ?? 0);

                    // Auto cell color
                    const autoCellColor =
                      conditionalFormat === "cell" &&
                      (col.type === "number" || col.type === "percent")
                        ? getAutoStatusColor(
                            typeof raw === "number" ? raw : Number(raw ?? 0),
                            col.type,
                            maxVal,
                          )
                        : null;
                    // M-4: heatmap style
                    const heatmapStyle = getHeatmapStyle(col.key, raw ?? 0);
                    const baseStyle = autoCellColor
                      ? { background: autoCellColor, ...cellStyle }
                      : cellStyle;
                    // M-3: sticky first column style for td
                    const isFirstCol = !expandableRows && colIndex === 0;
                    const stickyTdStyle: React.CSSProperties =
                      stickyFirstColumn && isFirstCol
                        ? {
                            position: "sticky",
                            left: 0,
                            background: stickyBg,
                            zIndex: 1,
                            borderRight: stickyBorder,
                          }
                        : {};
                    // #18: column-level conditional formatting rules
                    const columnRuleColor = getColumnRuleColor(
                      col.key,
                      raw ?? 0,
                      columnRules,
                    );
                    const columnRuleStyle: React.CSSProperties = columnRuleColor
                      ? { backgroundColor: columnRuleColor }
                      : {};
                    const finalCellStyle = {
                      ...stickyTdStyle,
                      ...baseStyle,
                      ...heatmapStyle,
                      ...columnRuleStyle,
                    };

                    if (
                      isBar &&
                      (col.type === "number" || col.type === "percent")
                    ) {
                      return (
                        <td
                          key={col.key}
                          className={cn(TD, "relative overflow-hidden !p-0")}
                          style={{ textAlign: align, ...finalCellStyle }}
                        >
                          <div
                            className="pointer-events-none absolute inset-y-0 left-0"
                            style={{
                              width: `${barPct}%`,
                              background: `color-mix(in srgb, ${getChartColor(
                                0,
                              )} 20%, transparent)`,
                            }}
                          />
                          <span className="relative z-[1] block px-2 py-1.5">
                            {raw != null ? formatCell(raw, col.type) : ""}
                          </span>
                        </td>
                      );
                    }
                    const cellId = `${rowIdx}-${col.key}`;
                    const isCopied = copiedCell === cellId;
                    return (
                      <td
                        key={col.key}
                        className={TD}
                        style={{
                          textAlign: align,
                          ...finalCellStyle,
                          ...(isCopied
                            ? {
                                outline: `2px solid ${getChartColor(0)}`,
                                outlineOffset: -2,
                              }
                            : {}),
                          cursor: "copy",
                        }}
                        title="クリックでコピー"
                        onClick={(e) => {
                          e.stopPropagation();
                          const cellValue =
                            raw != null ? formatCell(raw, col.type) : "";
                          navigator.clipboard?.writeText(cellValue).catch(() => {});
                          setCopiedCell(cellId);
                          setTimeout(() => setCopiedCell(null), 1000);
                        }}
                      >
                        {isCopied ? (
                          <span
                            className="text-[11px] font-semibold"
                            style={{ color: getChartColor(0) }}
                          >
                            コピー!
                          </span>
                        ) : raw != null ? (
                          formatCell(raw, col.type)
                        ) : (
                          ""
                        )}
                      </td>
                    );
                  })}
                </tr>
                {/* L-4: expanded sub-row */}
                {expandableRows && isExpanded && (
                  <tr key={`expand-${rowIdx}`}>
                    <td className={TD} />
                    <td
                      className={TD}
                      colSpan={
                        columns.filter((c) => !hiddenCols.has(c.key)).length
                      }
                      style={{ background: mutedBg, padding: "8px 12px" }}
                    >
                      <div className="flex flex-wrap gap-x-4 gap-y-2">
                        {columns.map((col) => (
                          <div key={col.key} className="text-[12px]">
                            <span className="mr-1 text-[color:var(--muted-foreground)]">
                              {col.label}:
                            </span>
                            <span className="font-medium">
                              {row[col.key] != null
                                ? formatCell(row[col.key]!, col.type)
                                : "—"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
        {/* H-2: Total row */}
        {showTotalRow && totalRowValues && (
          <tfoot>
            <tr
              className="font-bold"
              style={{ background: mutedBg }}
            >
              {expandableRows && <td className={TD} />}
              {columns.map((col, colIndex) => {
                if (hiddenCols.has(col.key)) {
                  return (
                    <td
                      key={col.key}
                      className={TD}
                      style={{
                        width: 28,
                        minWidth: 28,
                        padding: 0,
                        background: mutedBg,
                      }}
                    />
                  );
                }
                const val = totalRowValues[col.key];
                const align = resolveAlign(col);
                const isFirstCol = !expandableRows && colIndex === 0;
                const stickyTdStyle: React.CSSProperties =
                  stickyFirstColumn && isFirstCol
                    ? {
                        position: "sticky",
                        left: 0,
                        background: mutedBg,
                        zIndex: 1,
                        borderRight: stickyBorder,
                      }
                    : {};
                return (
                  <td
                    key={col.key}
                    className={TD}
                    style={{ textAlign: align, ...stickyTdStyle }}
                  >
                    {typeof val === "number"
                      ? formatCell(val, col.type)
                      : (val ?? "")}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        )}
      </table>

      {totalPages > 1 && (
        <div className={PAGINATION}>
          <span>
            {totalRows}件中 {(currentPage - 1) * (pageSize ?? totalRows) + 1}〜
            {Math.min(currentPage * (pageSize ?? totalRows), totalRows)}件
          </span>
          <button
            className={PAGE_BTN}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
          >
            ◀
          </button>
          <span>
            {currentPage} / {totalPages}
          </span>
          <button
            className={PAGE_BTN}
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
          >
            ▶
          </button>
        </div>
      )}
      <div className={FOOTER}>全 {totalRows} 件</div>
    </div>
  );
}
