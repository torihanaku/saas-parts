import type { ComponentType, CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface DashboardGridProps {
  /** 列数（CSS グリッド／react-grid-layout の cols 双方に反映）。 */
  columns?: number;
  /** アイテム間の余白 (px)。 */
  gap?: number;
  children?: ReactNode;
  className?: string;
  /**
   * react-grid-layout に渡すレイアウト。`gridComponent` を注入し `layout` を指定すると
   * D&D/リサイズ可能なグリッドで描画する。未注入なら素の CSS グリッドにフォールバックする。
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
  /**
   * D&D グリッドを使う場合に react-grid-layout の GridLayout コンポーネントを注入する。
   * （キットは react-grid-layout を import しない＝ブラウザ/バンドラ安全・依存を強制しない。
   *  例: `import GridLayout from "react-grid-layout"; <DashboardGrid gridComponent={GridLayout} layout={...} />`）
   */
  gridComponent?: ComponentType<Record<string, unknown>>;
}

/**
 * ダッシュボードのグリッド枠。既定は依存ゼロの CSS グリッド。
 * D&D/リサイズが必要なら消費側が `gridComponent`（react-grid-layout）を注入する
 * （キット自身は Node/optional 依存を持ち込まないのでブラウザでも安全）。
 */
export function DashboardGrid({
  columns = 12,
  gap = 16,
  children,
  className,
  layout,
  rowHeight = 60,
  width,
  onLayoutChange,
  gridComponent: GridLayout,
}: DashboardGridProps) {
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
