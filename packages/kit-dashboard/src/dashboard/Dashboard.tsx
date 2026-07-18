import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { DashboardGrid } from "../layout/DashboardGrid";
import { FilterDropdownWidget } from "../filters/FilterDropdownWidget";
import { FilterCheckboxWidget } from "../filters/FilterCheckboxWidget";
import { FilterSliderWidget } from "../filters/FilterSliderWidget";
import { FilterDateWidget } from "../filters/FilterDateWidget";
import { FilterInputWidget } from "../filters/FilterInputWidget";
import { WIDGET_REGISTRY } from "./registry";
import type {
  DashboardConfig,
  DashboardFilter,
  DashboardProps,
  DashboardWidget,
  FilterState,
} from "./types";

interface WidgetState {
  loading: boolean;
  error: Error | null;
  props: Record<string, unknown> | null;
}

function initialFilterState(config: DashboardConfig): FilterState {
  const state: FilterState = {};
  for (const f of config.filters ?? []) {
    if (f.defaultValue !== undefined) state[f.key] = f.defaultValue;
  }
  return state;
}

function FilterControl({
  filter,
  value,
  onChange,
}: {
  filter: DashboardFilter;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (filter.type) {
    case "dropdown":
      return (
        <FilterDropdownWidget
          label={filter.label}
          options={filter.options ?? []}
          value={value as string | undefined}
          onChange={(v) => onChange(v)}
        />
      );
    case "checkbox":
      return (
        <FilterCheckboxWidget
          label={filter.label}
          options={filter.options ?? []}
          value={value as string[] | undefined}
          onChange={(v) => onChange(v)}
        />
      );
    case "slider":
      return (
        <FilterSliderWidget
          label={filter.label}
          min={filter.min}
          max={filter.max}
          step={filter.step}
          value={value as number | undefined}
          onChange={(v) => onChange(v)}
        />
      );
    case "date":
      return (
        <FilterDateWidget
          label={filter.label}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          value={value as any}
          onChange={(v) => onChange(v)}
        />
      );
    case "input":
      return (
        <FilterInputWidget
          label={filter.label}
          value={value as string | undefined}
          onChange={(v) => onChange(v)}
        />
      );
    default:
      return null;
  }
}

/**
 * 宣言的な config とデータ供給関数 `dataProvider` から、フィルタ連動の
 * ダッシュボードを1枚描画する薄いオーケストレーター。
 * データ取得・保存は注入式（キットは fetch も persistence も持たない）。
 */
export function Dashboard({
  config: configProp,
  dataProvider,
  store,
  renderLoading,
  renderError,
  className,
}: DashboardProps) {
  const [config, setConfig] = useState<DashboardConfig>(configProp);
  const [filters, setFilters] = useState<FilterState>(() =>
    initialFilterState(configProp),
  );
  const [widgetStates, setWidgetStates] = useState<Record<string, WidgetState>>(
    {},
  );

  // 任意の永続化層から初期 config を読み込む（あれば prop を上書き）。
  useEffect(() => {
    let cancelled = false;
    if (!store?.load) return;
    Promise.resolve(store.load()).then((loaded) => {
      if (!cancelled && loaded) {
        setConfig(loaded);
        setFilters(initialFilterState(loaded));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  const columns = config.columns ?? 12;
  const gap = config.gap ?? 16;

  // フィルタが変わるたびに全ウィジェットを再取得（クロスフィルタ）。
  // 世代カウンタで古い結果を捨てる。
  const genRef = useRef(0);
  const fetchAll = useCallback(() => {
    const gen = ++genRef.current;
    for (const widget of config.widgets) {
      setWidgetStates((prev) => ({
        ...prev,
        [widget.id]: {
          loading: true,
          error: null,
          props: prev[widget.id]?.props ?? null,
        },
      }));
      Promise.resolve(dataProvider({ widget, filters }))
        .then((props) => {
          if (gen !== genRef.current) return;
          setWidgetStates((prev) => ({
            ...prev,
            [widget.id]: { loading: false, error: null, props },
          }));
        })
        .catch((err: unknown) => {
          if (gen !== genRef.current) return;
          setWidgetStates((prev) => ({
            ...prev,
            [widget.id]: {
              loading: false,
              error: err instanceof Error ? err : new Error(String(err)),
              props: null,
            },
          }));
        });
    }
  }, [config.widgets, dataProvider, filters]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const setFilter = (key: string, value: unknown) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  return (
    <div className={cn("w-full", className)}>
      {config.title && (
        <h2 className="mb-3 text-lg font-semibold" style={{ color: "var(--foreground)" }}>
          {config.title}
        </h2>
      )}

      {config.filters && config.filters.length > 0 && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          {config.filters.map((f) => (
            <FilterControl
              key={f.key}
              filter={f}
              value={filters[f.key]}
              onChange={(v) => setFilter(f.key, v)}
            />
          ))}
        </div>
      )}

      <DashboardGrid columns={columns} gap={gap}>
        {config.widgets.map((widget) => {
          const Chart = WIDGET_REGISTRY[widget.type];
          const st = widgetStates[widget.id];
          const span = Math.max(1, Math.min(columns, widget.layout?.w ?? columns));
          return (
            <div
              key={widget.id}
              data-widget={widget.id}
              className="rounded-xl border p-3"
              // 面・境界は shadcn トークン参照でテーマ追従
              style={{
                gridColumn: `span ${span}`,
                borderColor: "var(--border)",
                background: "var(--card)",
              }}
            >
              {widget.title && (
                <div
                  className="mb-2 text-sm font-medium"
                  style={{ color: "var(--foreground)" }}
                >
                  {widget.title}
                </div>
              )}
              {!Chart ? (
                <div className="text-xs" style={{ color: "var(--chart-negative)" }}>
                  未登録のウィジェット種別: {widget.type}
                </div>
              ) : st?.error ? (
                renderError ? (
                  renderError(widget, st.error)
                ) : (
                  <div className="text-xs" style={{ color: "var(--chart-negative)" }}>
                    ⚠ {st.error.message}
                  </div>
                )
              ) : st?.loading && !st.props ? (
                renderLoading ? (
                  renderLoading(widget)
                ) : (
                  <div
                    className="animate-pulse py-8 text-center text-xs"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    読み込み中…
                  </div>
                )
              ) : (
                <Chart {...(widget.props ?? {})} {...(st?.props ?? {})} />
              )}
            </div>
          );
        })}
      </DashboardGrid>
    </div>
  );
}
