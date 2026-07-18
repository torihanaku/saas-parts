import { chartColorVar, token, FALLBACK_PALETTE, PALETTE_SIZE } from "./theme";

/**
 * インデックスから chartPalette の色を循環取得する。
 * 返り値は `"var(--chart-N)"` 文字列で、SVG fill/stroke にそのまま渡すと
 * ダークモード切替に自動追従する（実体色が要る箇所は theme.ts の resolveChartColor）。
 */
export function getChartColor(index: number): string {
  return chartColorVar(index);
}

/** 値に基づくトレンドカラー（正 → positive, 負 → negative, 0 → muted） */
export function getTrendColor(value: number): string {
  if (value > 0) return token("--chart-positive");
  if (value < 0) return token("--chart-negative");
  return token("--muted-foreground");
}

/**
 * 名前付きカラースキーム（ユーザーが明示選択する配色なので実体色のまま保持）。
 */
export const COLOR_SCHEMES: Record<string, string[]> = {
  blue: ["#4285F4", "#1A73E8", "#8AB4F8", "#185ABC", "#AECBFA"],
  green: ["#34A853", "#137333", "#81C995", "#0D652D", "#A8DAB5"],
  orange: ["#FBBC04", "#F29900", "#FDD663", "#E37400", "#FEF08A"],
  purple: ["#9B59B6", "#7D3C98", "#D2B4DE", "#6C3483", "#E8DAEF"],
  red: ["#EA4335", "#C5221F", "#F28B82", "#A50E0E", "#FAD2CF"],
};

/** テーマ由来の既定パレット（var() 文字列 5色。多系列チャートの既定配色） */
function defaultThemePalette(): string[] {
  return [0, 1, 2, 3, 4].map((i) => chartColorVar(i));
}

// モジュールレベルのテーマ配色オーバーライド（ビルダーがテーマ変更時に差し替える用途）。
// 既定は CSS 変数参照。呼ばれなければテーマ追従のまま。
let _globalThemeColors: string[] | null = null;

export function setGlobalChartColors(colors: string[]): void {
  _globalThemeColors = colors;
}

export function getGlobalChartColors(): string[] {
  return _globalThemeColors ?? defaultThemePalette();
}

export function getColorScheme(scheme: string | undefined, customColor?: string): string[] {
  if (scheme === "custom" && customColor) {
    return [customColor, customColor, customColor, customColor, customColor];
  }
  return COLOR_SCHEMES[scheme ?? ""] ?? getGlobalChartColors();
}

/** 生のフォールバック配列（実体色が必要な場面向けの参照用） */
export { FALLBACK_PALETTE, PALETTE_SIZE };
