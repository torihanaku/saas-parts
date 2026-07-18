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
  // 軸線・目盛り線は主張を落とす（薄く）。
  g.selectAll("line").attr("stroke", CHART_BORDER).attr("stroke-opacity", 0.4);
  g.selectAll("path.domain").attr("stroke", CHART_BORDER).attr("stroke-opacity", 0.4);
}

/** tickSize(-inner) で引いたグリッド用 <g> に適用する（domain は呼び出し側で remove 済み想定でも可）。 */
export function themeGrid(g: AnySel): void {
  // 極薄の水平グリッド（実線）。チャートを邪魔しない。
  g.selectAll("line").attr("stroke", CHART_BORDER).attr("stroke-opacity", 0.25);
  g.selectAll("text").attr("fill", CHART_TEXT_MUTED);
  g.select(".domain").remove();
}

let _gradSeq = 0;
/**
 * 縦方向の tint グラデーション（下=やや淡→上=濃）を defs に生成し `url(#id)` を返す。
 * ベタ塗りソリッドを避けて棒・面・矩形に「深み」を与えるための共通ヘルパ。
 * @param defs svg.append("defs") 済みの selection
 * @param color 基色（var(--chart-N) 等の文字列）
 * @param opts.dir "v"（縦・既定）| "h"（横）。bottomOpacity/topOpacity で濃淡を調整。
 */
export function tintGradient(
  defs: AnySel,
  color: string,
  opts: { dir?: "v" | "h"; bottomOpacity?: number; topOpacity?: number; id?: string } = {},
): string {
  const { dir = "v", bottomOpacity = 0.78, topOpacity = 1, id } = opts;
  const gid = id ?? `kit-tint-${_gradSeq++}`;
  const g = defs
    .append("linearGradient")
    .attr("id", gid)
    .attr("x1", dir === "h" ? "0" : "0")
    .attr("y1", dir === "h" ? "0" : "1")
    .attr("x2", dir === "h" ? "1" : "0")
    .attr("y2", "0");
  g.append("stop").attr("offset", "0%").attr("stop-color", color).attr("stop-opacity", bottomOpacity);
  g.append("stop").attr("offset", "100%").attr("stop-color", color).attr("stop-opacity", topOpacity);
  return `url(#${gid})`;
}
