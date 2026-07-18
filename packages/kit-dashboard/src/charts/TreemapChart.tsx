import { useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { categoricalColor, sequentialStep } from "../lib/chartRoles";
import { fillFor, SHAPE_RX } from "../lib/chartStyle";
import { resolveChartColor, CHART_TEXT, CHART_SURFACE, CHART_BORDER, CHART_TEXT_MUTED } from "../lib/theme";
import { formatCompact } from "../lib/formatters";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface TreemapNode {
  id: string;
  label: string;
  value?: number;
  parent?: string;
  color?: string;
}

export interface TreemapChartProps {
  data?: TreemapNode[];
  maxDepth?: number;
  showValues?: boolean;
  animated?: boolean;
  width?: number;
  height?: number;
  className?: string;
}

const DEFAULT_DATA: TreemapNode[] = [
  { id: "root", label: "顧客セグメント" },
  { id: "enterprise", label: "大手企業", parent: "root", value: 4500000 },
  { id: "mid", label: "中堅企業", parent: "root", value: 2800000 },
  { id: "smb", label: "SMB", parent: "root", value: 1200000 },
  { id: "startup", label: "スタートアップ", parent: "root", value: 800000 },
];

const MARGIN = { top: 8, right: 8, bottom: 8, left: 8 };
const BREADCRUMB_HEIGHT = 32;

export function TreemapChart({
  data = DEFAULT_DATA,
  maxDepth = 2,
  showValues = false,
  animated = true,
  width: propWidth,
  height = 320,
  className,
}: TreemapChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { show, hide, tooltipRef } = useTooltip();

  // Zoom/drill-down state: array of node IDs representing the path drilled into
  const [zoomPath, setZoomPath] = useState<string[]>([]);

  const width = propWidth ?? observedWidth;

  // When zoomed in, we need extra space for breadcrumb
  const breadcrumbVisible = zoomPath.length > 0;
  const effectiveMarginTop = MARGIN.top + (breadcrumbVisible ? BREADCRUMB_HEIGHT : 0);
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - effectiveMarginTop - MARGIN.bottom);

  const handleZoomIn = useCallback((nodeId: string) => {
    setZoomPath((prev) => [...prev, nodeId]);
  }, []);

  const handleZoomOut = useCallback((targetDepth?: number) => {
    if (targetDepth === undefined) {
      // Go back one level
      setZoomPath((prev) => prev.slice(0, -1));
    } else {
      setZoomPath((prev) => prev.slice(0, targetDepth));
    }
  }, []);

  // Determine the "focus root" based on zoomPath
  const focusRootId = zoomPath.length > 0 ? zoomPath[zoomPath.length - 1]! : null;

  // Build the filtered dataset for current zoom level
  const filteredData = useCallback((): TreemapNode[] => {
    if (!focusRootId) return data;

    // Collect all descendant IDs starting from focusRootId
    const descendants = new Set<string>();
    const queue = [focusRootId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      descendants.add(current);
      data.forEach((n) => {
        if (n.parent === current) queue.push(n.id);
      });
    }

    // Return the focused subtree with focusRootId as new root (no parent)
    return data
      .filter((n) => descendants.has(n.id))
      .map((n) => (n.id === focusRootId ? { ...n, parent: undefined } : n));
  }, [data, focusRootId]);

  // Get label for a node ID
  const getNodeLabel = useCallback(
    (id: string) => {
      return data.find((n) => n.id === id)?.label ?? id;
    },
    [data],
  );

  // We need a ref to pass handleZoomIn into the D3 render without stale closure issues
  const handleZoomInRef = useRef(handleZoomIn);
  handleZoomInRef.current = handleZoomIn;

  const currentData = filteredData();

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (innerWidth <= 0 || innerHeight <= 0 || currentData.length === 0) return;

      svg
        .attr("width", width)
        .attr("height", height - (breadcrumbVisible ? BREADCRUMB_HEIGHT : 0));

      const g = svg
        .append("g")
        .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

      // 矩形の共通標準塗り(fillFor)を色ごとに1度だけ生成してキャッシュ。値の大小は fill-opacity ランプで表現。
      const defs = svg.append("defs");
      const tintCache = new Map<string, string>();
      const rectTint = (color: string): string => {
        let url = tintCache.get(color);
        if (!url) {
          url = fillFor(defs, color);
          tintCache.set(color, url);
        }
        return url;
      };

      // Build hierarchy using stratify
      let root: d3.HierarchyNode<TreemapNode>;
      try {
        const stratify = d3
          .stratify<TreemapNode>()
          .id((d) => d.id)
          .parentId((d) => d.parent ?? null);

        root = stratify(currentData);
      } catch {
        return;
      }

      root.sum((d) => d.value ?? 0);

      // Apply treemap layout
      const treemapLayout = d3
        .treemap<TreemapNode>()
        .size([innerWidth, innerHeight])
        .tile(d3.treemapSquarify)
        .padding(2)
        .round(true);

      treemapLayout(root as d3.HierarchyRectangularNode<TreemapNode>);

      // Collect nodes up to maxDepth
      const nodes = (root as d3.HierarchyRectangularNode<TreemapNode>)
        .descendants()
        .filter((d) => d.depth > 0 && d.depth <= maxDepth);

      // Build a color index map for leaf nodes (stable ordering)
      const leafNodes = nodes.filter((d) => !d.children);
      const colorIndex = new Map<string, number>();
      leafNodes.forEach((d, i) => {
        colorIndex.set(d.data.id, i);
      });

      // 階層カテゴリ = 葉ごとに categoricalColor（真のカテゴリ色）。ベタ塗り回避のため
      // 値の大小は「不透明度ランプ（tint）」で表現し、RGB を手で暗くする処理は廃止する。
      // 返り値は { color(var 文字列), opacity }。呼び出し側は fill=color, fill-opacity=opacity。
      // ランプは葉を value 降順に順位付けし sequentialStep で 0.92→0.55 の階調。
      const leavesByValue = leafNodes
        .filter((n) => n.data.value != null)
        .sort((a, b) => (b.data.value ?? 0) - (a.data.value ?? 0));
      const valueRank = new Map<string, number>();
      leavesByValue.forEach((n, i) => valueRank.set(n.data.id, i));

      function resolveColor(d: d3.HierarchyRectangularNode<TreemapNode>): {
        color: string;
        opacity: number;
      } {
        if (d.data.color) return { color: d.data.color, opacity: 0.85 };
        if (!d.children) {
          const idx = colorIndex.get(d.data.id) ?? 0;
          const color = categoricalColor(idx);
          if (d.data.value != null) {
            const rank = valueRank.get(d.data.id) ?? 0;
            const { opacity } = sequentialStep(rank, Math.max(1, leavesByValue.length));
            return { color, opacity };
          }
          return { color, opacity: 0.85 };
        }
        // 親ノード: 最初の葉の hue を淡く敷く（下地）。
        const firstLeaf = d.leaves()[0];
        const idx = colorIndex.get(firstLeaf?.data.id ?? "") ?? 0;
        return { color: categoricalColor(idx), opacity: 0.28 };
      }

      // 背景輝度でテキスト色を決める。tint 塗り(半透明)はカード上で明るく見えるので
      // 実体 hue の輝度を基準に判定する。暗背景時のみ白抜き（#fff は可読テキストの例外）。
      function getTextColor(d: d3.HierarchyRectangularNode<TreemapNode>): string {
        const idx = colorIndex.get(d.data.id) ?? 0;
        const base = d.data.color ?? resolveChartColor(idx);
        const c = d3.color(base);
        const { opacity } = resolveColor(d);
        if (!c) return CHART_TEXT;
        const rgb = c.rgb();
        const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
        // 実効輝度 ≒ hue輝度 と白背景を opacity で線形合成した近似。
        const effective = luminance * opacity + 1 * (1 - opacity);
        return effective > 0.6 ? CHART_TEXT : "#ffffff";
      }

      // Cell groups
      const cellGroups = g
        .selectAll<SVGGElement, d3.HierarchyRectangularNode<TreemapNode>>(".treemap-cell")
        .data(nodes)
        .join("g")
        .attr("class", "treemap-cell")
        .style("cursor", "pointer")
        .attr("transform", (d) => `translate(${d.x0},${d.y0})`);

      // Rectangles
      const rects = cellGroups
        .append("rect")
        .attr("width", (d) => Math.max(0, d.x1 - d.x0))
        .attr("height", (d) => Math.max(0, d.y1 - d.y0))
        .attr("rx", SHAPE_RX)
        .attr("fill", (d) => rectTint(resolveColor(d).color))
        .attr("fill-opacity", (d) => resolveColor(d).opacity)
        .style("cursor", (d) => (d.children ? "zoom-in" : "pointer"));

      if (animated) {
        rects
          .attr("opacity", 0)
          .transition()
          .duration(500)
          .ease(d3.easeCubicOut)
          .attr("opacity", 1);
      }

      // Labels
      cellGroups
        .filter((d) => d.x1 - d.x0 > 40 && d.y1 - d.y0 > 30)
        .append("text")
        .style("pointer-events", "none")
        .style("user-select", "none")
        .attr("x", 6)
        .attr("y", 16)
        .attr("font-size", "13px")
        .attr("fill", (d) => getTextColor(d))
        .text((d) => d.data.label);

      // Value labels (always show inside cells when large enough)
      cellGroups
        .filter((d) => d.x1 - d.x0 > 40 && d.y1 - d.y0 > 48)
        .append("text")
        .style("pointer-events", "none")
        .style("user-select", "none")
        .attr("x", 6)
        .attr("y", 32)
        .attr("font-size", "11px")
        .attr("fill", (d) =>
          getTextColor(d) === "#ffffff"
            ? "rgba(255,255,255,0.75)"
            : "rgba(0,0,0,0.6)",
        )
        .text((d) => (d.data.value != null ? formatCompact(d.data.value) : ""));

      // Interaction
      cellGroups
        .on("mouseenter", function (event: MouseEvent, d) {
          d3.select(this).select("rect").attr("opacity", 0.8);

          // Build full path for tooltip
          const pathParts: string[] = [];
          // Include zoom path context
          zoomPath.forEach((id) => pathParts.push(getNodeLabel(id)));
          // Walk up the hierarchy for current node
          const nodePath: string[] = [];
          let current: d3.HierarchyRectangularNode<TreemapNode> | null = d;
          while (current) {
            if (current.depth > 0) nodePath.unshift(current.data.label);
            current = current.parent as d3.HierarchyRectangularNode<TreemapNode> | null;
          }
          pathParts.push(...nodePath);

          const val = d.data.value != null ? formatCompact(d.data.value) : "";
          const fullPath = pathParts.join(" > ");
          const tooltipText = val ? `${fullPath}\n${val}` : fullPath;
          show(event, tooltipText);
        })
        .on("mouseleave", function () {
          d3.select(this).select("rect").attr("opacity", 1);
          hide();
        })
        .on("click", function (_event: MouseEvent, d) {
          // Only drill down if node has children
          if (d.children) {
            handleZoomInRef.current(d.data.id);
          }
        });
    },
    [
      currentData,
      maxDepth,
      showValues,
      animated,
      width,
      height,
      innerWidth,
      innerHeight,
      breadcrumbVisible,
      zoomPath,
      getNodeLabel,
    ],
  );

  // Build breadcrumb items: root + each node in zoomPath
  const breadcrumbItems = [
    { id: "root", label: data.find((n) => !n.parent)?.label ?? "ルート", depth: 0 },
    ...zoomPath.map((id, i) => ({ id, label: getNodeLabel(id), depth: i + 1 })),
  ];

  return (
    <div
      ref={containerRef}
      className={cn("relative flex w-full flex-col overflow-hidden", className)}
      role="img"
      aria-label="ツリーマップチャート"
    >
      {breadcrumbVisible && (
        <div
          className="flex min-h-[32px] flex-wrap items-center gap-1 px-2 py-1 text-[13px]"
          style={{
            background: CHART_SURFACE,
            borderBottom: `1px solid ${CHART_BORDER}`,
          }}
        >
          {breadcrumbItems.map((item, idx) => (
            <span key={item.id} className="flex items-center gap-1">
              {idx > 0 && (
                <span className="text-[14px] leading-none" style={{ color: CHART_TEXT_MUTED }}>
                  ›
                </span>
              )}
              {idx < breadcrumbItems.length - 1 ? (
                <button
                  type="button"
                  className="cursor-pointer rounded-[3px] px-1 py-0.5 text-[13px] underline underline-offset-2"
                  style={{ background: "none", border: "none", color: categoricalColor(0) }}
                  onClick={() => handleZoomOut(item.depth)}
                  title={`${item.label} に戻る`}
                >
                  {item.label}
                </button>
              ) : (
                <span className="text-[13px] font-semibold" style={{ color: CHART_TEXT }}>
                  {item.label}
                </span>
              )}
            </span>
          ))}
          <button
            type="button"
            className="ml-auto cursor-pointer whitespace-nowrap rounded px-2 py-0.5 text-[11px]"
            style={{ background: "none", border: `1px solid ${CHART_BORDER}`, color: CHART_TEXT_MUTED }}
            onClick={() => handleZoomOut()}
            title="一つ上のレベルに戻る"
          >
            ← 戻る
          </button>
        </div>
      )}
      <svg ref={svgRef} />
      <ChartTooltip ref={tooltipRef} />
    </div>
  );
}
