import type { Selection } from "d3";
import {
  CHART_TEXT_MUTED,
  CHART_BORDER,
  CHART_AXIS_FONT_SIZE,
} from "./theme";

/**
 * D3 の軸/グリッドは DashMock では global CSS(.d3-axis / .d3-grid) で着色していた。
 * キットは global CSS を持ち込まないので、生成直後にここでテーマトークンを当てる。
 * すべて `var(...)` 文字列で塗るため、ダークモード切替に再描画なしで追従する。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySel = Selection<any, unknown, any, unknown>;

/** d3.axisBottom/Left 等を .call した直後の <g> に適用する。 */
export function themeAxis(g: AnySel): void {
  g.selectAll("text")
    .attr("fill", CHART_TEXT_MUTED)
    .attr("font-size", CHART_AXIS_FONT_SIZE);
  g.selectAll("line").attr("stroke", CHART_BORDER);
  g.selectAll("path.domain").attr("stroke", CHART_BORDER);
}

/** tickSize(-inner) で引いたグリッド用 <g> に適用する（domain は呼び出し側で remove 済み想定でも可）。 */
export function themeGrid(g: AnySel): void {
  g.selectAll("line").attr("stroke", CHART_BORDER).attr("stroke-opacity", 0.5);
  g.selectAll("text").attr("fill", CHART_TEXT_MUTED);
  g.select(".domain").remove();
}
