// チャートの「見た目グラマー」を一本化する共有スタイル層。
// 色ロール（何色か＝chartRoles）とは分離し、「どう塗るか/角丸/hover の強さ」を統一する。
import type { Selection } from "d3";
import { tintGradient } from "./d3Theme";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySel = Selection<any, unknown, any, unknown>;

/** 全 filled shape（rect/bar/box 等）共通の角丸。現状 4/3/2/0 混在を一本化。 */
export const SHAPE_RX = 3;

/** hover フェードの共通不透明度（値の統一。適用は各チャートの hover ハンドラ内で）。 */
export const HOVER_OPACITY = 0.85;

/**
 * 唯一の標準塗り。全 filled shape はこれで塗る＝**同一の微妙な縦グラデ**（下やや淡→上濃）で
 * "深み"を統一する（ベタ塗り/多色バラ塗りの混在を解消）。color は色ロールで決めた hue を渡す:
 *   単一指標 → PRIMARY() / categoricalColor(0)、カテゴリ → categoricalColor(i)、意味 → semanticColor(...)。
 * hue が変わるだけで**塗り処理は共通**。
 * @param defs svg.append("defs") 済みの selection
 * @param color 基色（var(--chart-N) 等）
 * @param id 任意の固定 id（省略時は自動採番）
 */
export function fillFor(defs: AnySel, color: string, id?: string): string {
  return tintGradient(defs, color, {
    dir: "v",
    bottomOpacity: 0.82,
    topOpacity: 1,
    id,
  });
}

/**
 * 小面積要素（点/リンク/線）や連続カラーランプ（Heatmap/Geo）はグラデ対象外＝ロール色を flat のまま使う。
 * これは規約の明示用マーカー（実処理は無し）。
 */
export const FLAT_EXEMPT = true;
