import { useRef } from "react";
import * as d3 from "d3";
import {
  sankey as d3Sankey,
  sankeyLinkHorizontal,
  type SankeyGraph,
  type SankeyNode as D3SankeyNode,
  type SankeyLink as D3SankeyLink,
} from "d3-sankey";
import { useD3 } from "../lib/useD3";
import { useResizeObserver } from "../lib/useResizeObserver";
import { useTooltip } from "../lib/useTooltip";
import { getChartColor } from "../lib/colorUtils";
import { formatNumber } from "../lib/formatters";
import { CHART_TEXT, CHART_TEXT_MUTED } from "../lib/theme";
import { cn } from "../lib/cn";
import { ChartTooltip } from "../primitives/ChartTooltip";

export interface SankeyNode {
  id: string;
  label: string;
  color?: string;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

export type SankeyLinkColorMode = "gray" | "source" | "target";

export interface SankeyChartProps {
  nodes?: SankeyNode[];
  links?: SankeyLink[];
  linkColorMode?: SankeyLinkColorMode;
  nodeWidth?: number;
  nodePadding?: number;
  animatedLinks?: boolean;
  width?: number;
  height?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  className?: string;
}

// Internal node type for d3-sankey (needs index for color lookup)
interface InternalNode
  extends D3SankeyNode<
    { origIndex: number; id: string; label: string; color?: string },
    object
  > {
  origIndex: number;
  id: string;
  label: string;
  color?: string;
}

type InternalLink = D3SankeyLink<InternalNode, object>;

const DEFAULT_SANKEY_MARGIN = { top: 10, right: 150, bottom: 10, left: 150 };

export function SankeyChart({
  nodes = SANKEY_DEFAULT_NODES,
  links = SANKEY_DEFAULT_LINKS,
  linkColorMode = "gray",
  nodeWidth = 15,
  nodePadding = 12,
  animatedLinks = false,
  width: propWidth,
  height = 400,
  margin = DEFAULT_SANKEY_MARGIN,
  className,
}: SankeyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: observedWidth } = useResizeObserver(containerRef);
  const { state: tooltipState, show, hide } = useTooltip();

  const width = propWidth ?? observedWidth;
  const innerWidth = Math.max(0, width - margin.left - margin.right);
  const innerHeight = Math.max(0, height - margin.top - margin.bottom);

  // Build id → color map for stable, theme-following node colors
  const nodeColorMap = new Map<string, string>(
    nodes.map((n, i) => [n.id, n.color ?? getChartColor(i)]),
  );

  const svgRef = useD3<SVGSVGElement>(
    (svg) => {
      if (
        nodes.length === 0 ||
        links.length === 0 ||
        innerWidth <= 0 ||
        innerHeight <= 0
      )
        return;

      svg.attr("width", width).attr("height", height);

      const g = svg
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      // Add defs for animated link gradient patterns
      const defs = svg.append("defs");

      // Build sankey input (d3-sankey mutates the objects, so clone)
      const sankeyNodes: InternalNode[] = nodes.map(
        (n, i) =>
          ({
            origIndex: i,
            id: n.id,
            label: n.label,
            color: n.color,
          }) as unknown as InternalNode,
      );

      const nodeIdSet = new Set<string>(sankeyNodes.map((n) => n.id));

      // nodeId(d => d.id) を使うので、リンクの source/target は node の id 文字列で参照する。
      const sankeyLinks = links
        .filter((l) => nodeIdSet.has(l.source) && nodeIdSet.has(l.target))
        .map((l) => ({
          source: l.source,
          target: l.target,
          value: l.value,
        }));

      const sankeyGen = d3Sankey<InternalNode, object>()
        .nodeId((d) => d.id)
        .nodeWidth(nodeWidth)
        .nodePadding(nodePadding)
        .extent([
          [0, 0],
          [innerWidth, innerHeight],
        ]);

      let graph: SankeyGraph<InternalNode, object>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        graph = sankeyGen({ nodes: sankeyNodes, links: sankeyLinks } as any);
      } catch {
        return;
      }

      const { nodes: layoutNodes, links: layoutLinks } = graph;

      // Create gradient for each animated link
      if (animatedLinks) {
        layoutLinks.forEach((link, i) => {
          const srcNode = link.source as InternalNode;
          const tgtNode = link.target as InternalNode;
          const srcColor = nodeColorMap.get(srcNode.id) ?? CHART_TEXT_MUTED;
          const tgtColor = nodeColorMap.get(tgtNode.id) ?? CHART_TEXT_MUTED;
          const gradId = `sankey-grad-${i}`;

          const grad = defs
            .append("linearGradient")
            .attr("id", gradId)
            .attr("gradientUnits", "userSpaceOnUse")
            .attr("x1", srcNode.x1 ?? 0)
            .attr("x2", tgtNode.x0 ?? 0);

          grad
            .append("stop")
            .attr("offset", "0%")
            .attr("stop-color", srcColor)
            .attr("stop-opacity", 0.6);
          grad
            .append("stop")
            .attr("offset", "100%")
            .attr("stop-color", tgtColor)
            .attr("stop-opacity", 0.3);
        });
      }

      // Draw links
      const linkPaths = g
        .selectAll<SVGPathElement, InternalLink>(".link")
        .data(layoutLinks as InternalLink[])
        .join("path")
        .attr("class", "link")
        .style("fill", "none")
        .attr("d", sankeyLinkHorizontal())
        .attr("stroke-width", (d) => Math.max(1, d.width ?? 1))
        .attr("stroke", (d, i) => {
          if (animatedLinks) return `url(#sankey-grad-${i})`;
          if (linkColorMode === "gray") return CHART_TEXT_MUTED;
          const srcNode = d.source as InternalNode;
          const tgtNode = d.target as InternalNode;
          if (linkColorMode === "source")
            return nodeColorMap.get(srcNode.id) ?? CHART_TEXT_MUTED;
          return nodeColorMap.get(tgtNode.id) ?? CHART_TEXT_MUTED;
        })
        .attr(
          "stroke-opacity",
          linkColorMode === "gray" && !animatedLinks ? 0.22 : 0.35,
        )
        .on("mouseenter", function (event: MouseEvent, d) {
          d3.select(this).attr("stroke-opacity", 0.55);
          const srcNode = d.source as InternalNode;
          const tgtNode = d.target as InternalNode;
          const val = formatNumber(d.value as number, 0);
          show(event, `${srcNode.label} → ${tgtNode.label}\n${val} 件`);
        })
        .on("mouseleave", function () {
          d3.select(this).attr(
            "stroke-opacity",
            linkColorMode === "gray" && !animatedLinks ? 0.22 : 0.35,
          );
          hide();
        });

      // Animated flow effect: a bright "pulse" traveling along the path
      if (animatedLinks) {
        linkPaths.each(function () {
          const pathEl = this as SVGPathElement;
          const pathLength = pathEl.getTotalLength();
          const dashLen = Math.min(40, pathLength * 0.2);

          d3.select(pathEl)
            .attr("stroke-dasharray", `${dashLen} ${pathLength}`)
            .attr("stroke-dashoffset", pathLength);

          function animate() {
            d3.select(pathEl)
              .attr("stroke-dashoffset", pathLength)
              .transition()
              .duration(2000)
              .ease(d3.easeLinear)
              .attr("stroke-dashoffset", -dashLen)
              .on("end", animate);
          }
          animate();
        });
      }

      // Draw nodes
      const nodeGroups = g
        .selectAll<SVGGElement, InternalNode>(".node")
        .data(layoutNodes as InternalNode[])
        .join("g")
        .attr("class", "node");

      nodeGroups
        .append("rect")
        .attr("class", "node-rect")
        .style("cursor", "default")
        .attr("x", (d) => d.x0 ?? 0)
        .attr("y", (d) => d.y0 ?? 0)
        .attr("width", (d) => (d.x1 ?? 0) - (d.x0 ?? 0))
        .attr("height", (d) => Math.max(1, (d.y1 ?? 0) - (d.y0 ?? 0)))
        .attr("rx", 3)
        .attr(
          "fill",
          (d) => nodeColorMap.get(d.id) ?? getChartColor(d.origIndex ?? 0),
        );

      // Node labels: left side if x0 > innerWidth/2, right side otherwise
      // Show label + value
      nodeGroups
        .append("text")
        .attr("class", "node-label")
        .style("pointer-events", "none")
        .attr("font-size", "13px")
        .attr("fill", CHART_TEXT)
        .attr("x", (d) => {
          const isRight = (d.x0 ?? 0) > innerWidth / 2;
          return isRight ? (d.x0 ?? 0) - 6 : (d.x1 ?? 0) + 6;
        })
        .attr("y", (d) => ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2 - 5)
        .attr("text-anchor", (d) =>
          (d.x0 ?? 0) > innerWidth / 2 ? "end" : "start",
        )
        .attr("dominant-baseline", "middle")
        .text((d) => d.label);

      // Value sub-label
      nodeGroups
        .append("text")
        .attr("class", "node-label")
        .style("pointer-events", "none")
        .attr("x", (d) => {
          const isRight = (d.x0 ?? 0) > innerWidth / 2;
          return isRight ? (d.x0 ?? 0) - 6 : (d.x1 ?? 0) + 6;
        })
        .attr("y", (d) => ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2 + 8)
        .attr("text-anchor", (d) =>
          (d.x0 ?? 0) > innerWidth / 2 ? "end" : "start",
        )
        .attr("dominant-baseline", "middle")
        .attr("font-size", 9)
        .attr("fill", CHART_TEXT_MUTED)
        .text((d) => {
          const val = (d.value as number | undefined) ?? 0;
          return formatNumber(val, 0);
        });
    },
    [
      nodes,
      links,
      width,
      height,
      innerWidth,
      innerHeight,
      linkColorMode,
      nodeWidth,
      nodePadding,
      animatedLinks,
    ],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", className)}
      style={{ position: "relative" }}
    >
      <svg
        ref={svgRef}
        className="block w-full overflow-visible"
        aria-label="サンキーチャート"
        role="img"
      />
      <ChartTooltip
        x={tooltipState.x}
        y={tooltipState.y}
        content={tooltipState.content}
        visible={tooltipState.visible}
      />
    </div>
  );
}

// Default sample data: lead flow (MQL sources → SQL stage → result)
export const SANKEY_DEFAULT_NODES: SankeyNode[] = [
  { id: "organic", label: "オーガニック検索" },
  { id: "paid", label: "有料広告" },
  { id: "event", label: "イベント" },
  { id: "referral", label: "リファラル" },
  { id: "mql", label: "MQL" },
  { id: "sql", label: "SQL" },
  { id: "won", label: "受注" },
  { id: "lost", label: "失注" },
];

export const SANKEY_DEFAULT_LINKS: SankeyLink[] = [
  { source: "organic", target: "mql", value: 320 },
  { source: "paid", target: "mql", value: 210 },
  { source: "event", target: "mql", value: 140 },
  { source: "referral", target: "mql", value: 80 },
  { source: "mql", target: "sql", value: 480 },
  { source: "mql", target: "lost", value: 270 },
  { source: "sql", target: "won", value: 210 },
  { source: "sql", target: "lost", value: 270 },
];

// SaaS funnel mock data
export const SANKEY_SAAS_NODES: SankeyNode[] = [
  { id: "organic", label: "オーガニック", color: "#34A853" },
  { id: "paid", label: "有料広告", color: "#4285F4" },
  { id: "referral", label: "紹介", color: "#FBBC04" },
  { id: "mql", label: "MQL", color: "#FF6D00" },
  { id: "sql", label: "SQL", color: "#9C27B0" },
  { id: "deal", label: "商談", color: "#00897B" },
  { id: "won", label: "成約", color: "#34A853" },
  { id: "lost", label: "失注", color: "#EA4335" },
];

export const SANKEY_SAAS_LINKS: SankeyLink[] = [
  { source: "organic", target: "mql", value: 320 },
  { source: "paid", target: "mql", value: 210 },
  { source: "referral", target: "mql", value: 95 },
  { source: "mql", target: "sql", value: 185 },
  { source: "mql", target: "lost", value: 440 },
  { source: "sql", target: "deal", value: 96 },
  { source: "sql", target: "lost", value: 89 },
  { source: "deal", target: "won", value: 62 },
  { source: "deal", target: "lost", value: 34 },
];
