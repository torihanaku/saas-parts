// 配色ロール（kit 全チャート共通の色戦略）。
// 個々のチャートがパレットを直に呼ぶのをやめ、「このデータは何ロールか」を宣言して色を取る。
// これにより「順序/単一指標＝モノクローム、カテゴリ＝抑えた少数色、意味＝semantic」を構造的に統一する。
import {
  chartColorVar,
  token,
  CHART_POSITIVE,
  CHART_NEGATIVE,
  CHART_WARNING,
  CHART_TEXT_MUTED,
} from "./theme";

/**
 * SEQUENTIAL（順序・単一指標）: 単一 hue を「不透明度ランプ」で差別化する。
 * ファネル/ヒストグラム/単一系列棒/単一指標のツリーマップ等。虹色にしない。
 * @returns { color: var(--chart-N), opacity } — 呼び出し側は fill=color, fill-opacity=opacity。
 */
export function sequentialStep(
  index: number,
  count: number,
  hueIndex = 0,
): { color: string; opacity: number } {
  const t = count > 1 ? index / (count - 1) : 0;
  const opacity = Math.max(0.55, 0.92 - t * 0.42); // 上=濃→下=淡・floor 0.55（可読性確保）
  return { color: chartColorVar(hueIndex), opacity };
}

/** CATEGORICAL（真のカテゴリ）: 抑えた少数色パレット（多系列・区分の識別が必要な時だけ）。 */
export function categoricalColor(index: number): string {
  return chartColorVar(index);
}

/** SEMANTIC（意味を運ぶ色）: 増減・しきい値・状態。 */
export type Semantic = "positive" | "negative" | "warning" | "neutral";
export function semanticColor(s: Semantic): string {
  switch (s) {
    case "positive":
      return CHART_POSITIVE;
    case "negative":
      return CHART_NEGATIVE;
    case "warning":
      return CHART_WARNING;
    default:
      return CHART_TEXT_MUTED;
  }
}

/** 単一指標の「面/塗り」の既定不透明度（ベタ塗り回避の下地）。 */
export const FILL_OPACITY = 0.9;

// 便宜: 主系列色（brand相当＝chart-1）。単一系列のデフォルト。
export const PRIMARY = () => chartColorVar(0);
export { token };
