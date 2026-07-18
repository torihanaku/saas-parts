import { createRequire } from "node:module";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface DashboardGridProps {
  /** 列数（CSS グリッド／react-grid-layout の cols 双方に反映）。 */
  columns?: number;
  /** アイテム間の余白 (px)。 */
  gap?: number;
  children?: ReactNode;
  className?: string;
  /**
   * react-grid-layout に渡すレイアウト。指定があり react-grid-layout が
   * インストール済みなら D&D/リサイズ可能なグリッドで描画する。
   * 未指定 or 未インストールなら素の CSS グリッドにフォールバックする。
   */
  layout?: Array<{
    i: string;
    x: number;
    y: number;
    w: number;
    h: number;
    [key: string]: unknown;
  }>;
  rowHeight?: number;
  width?: number;
  onLayoutChange?: (layout: DashboardGridProps["layout"]) => void;
}

/**
 * react-grid-layout の薄いラッパ。`react-grid-layout` は optional peerDep なので、
 * 未インストール環境では静的 import で壊さず素の CSS グリッドに退避する。
 */
function loadGridLayout(): React.ComponentType<Record<string, unknown>> | null {
  try {
    // optional peerDep。存在すれば default export の GridLayout を返す。
    // ESM パッケージなので createRequire で同期解決する（未インストールなら catch）。
    const req = createRequire(import.meta.url);
    const mod = req("react-grid-layout") as {
      default?: React.ComponentType<Record<string, unknown>>;
    };
    return (
      mod.default ??
      (mod as unknown as React.ComponentType<Record<string, unknown>>)
    );
  } catch {
    return null;
  }
}

export function DashboardGrid({
  columns = 12,
  gap = 16,
  children,
  className,
  layout,
  rowHeight = 60,
  width,
  onLayoutChange,
}: DashboardGridProps) {
  const GridLayout = layout ? loadGridLayout() : null;

  if (GridLayout && layout) {
    return (
      <div className={cn("relative w-full", className)}>
        <GridLayout
          className="layout"
          layout={layout}
          cols={columns}
          rowHeight={rowHeight}
          margin={[gap, gap]}
          width={width ?? 1200}
          onLayoutChange={onLayoutChange}
        >
          {children}
        </GridLayout>
      </div>
    );
  }

  return (
    <div
      className={cn("grid w-full", className)}
      style={
        {
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: `${gap}px`,
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}
