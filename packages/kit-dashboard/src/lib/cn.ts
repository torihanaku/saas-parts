/**
 * 依存ゼロの className 連結ヘルパ。真値のみを空白区切りで結合する。
 * （tailwind-merge は入れない。競合しうる上書きは呼び出し側で避ける方針。）
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
