/**
 * テーマ非依存カラー解決。
 *
 * このキットのチャートは色をハードコードせず、CSS 変数を参照する。方針は2段構え:
 *
 * 1. **描画に直接埋め込む色** は `chartColorVar(i)` / `token(name)` が返す
 *    `"var(--chart-1)"` 形式の文字列を SVG の fill/stroke にそのまま渡す。
 *    → ダークモード切替時、React 再描画なしにブラウザが再解決して色が追従する。
 *
 * 2. **色の明暗操作や補間が必要な場合**（d3.color(c).darker() 等）は
 *    `resolveVar(name)` で getComputedStyle から実体（hex/rgb）を取り出して使う。
 *    jsdom/SSR など解決できない環境では組み込みフォールバックを返す。
 */

/** シーケンシャル・パレットのフォールバック（theme.css の :root と一致） */
export const FALLBACK_PALETTE = [
  "#4285f4",
  "#ea4335",
  "#fbbc04",
  "#34a853",
  "#fa7b17",
  "#f53ba0",
  "#a142f4",
  "#24c1e0",
] as const;

export const PALETTE_SIZE = FALLBACK_PALETTE.length;

const FALLBACKS: Record<string, string> = {
  "--chart-1": FALLBACK_PALETTE[0],
  "--chart-2": FALLBACK_PALETTE[1],
  "--chart-3": FALLBACK_PALETTE[2],
  "--chart-4": FALLBACK_PALETTE[3],
  "--chart-5": FALLBACK_PALETTE[4],
  "--chart-6": FALLBACK_PALETTE[5],
  "--chart-7": FALLBACK_PALETTE[6],
  "--chart-8": FALLBACK_PALETTE[7],
  "--chart-positive": "#34a853",
  "--chart-negative": "#ea4335",
  "--chart-warning": "#fbbc04",
  "--foreground": "#202124",
  "--muted-foreground": "#5f6368",
  "--border": "#e0e0e0",
  "--card": "#ffffff",
  "--popover": "#ffffff",
  "--popover-foreground": "#202124",
};

/**
 * `"var(--name, fallback)"` を返す。SVG fill/stroke やインラインスタイルに
 * そのまま渡す用途。ホストが未定義でも fallback で描画が壊れない。
 */
export function token(name: string): string {
  const varName = name.startsWith("--") ? name : `--${name}`;
  const fb = FALLBACKS[varName];
  return fb ? `var(${varName}, ${fb})` : `var(${varName})`;
}

/** インデックス i（0始まり）を --chart-1..8 に循環マッピングした var() 文字列 */
export function chartColorVar(index: number): string {
  const n = (((index % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE) + 1;
  return token(`--chart-${n}`);
}

/**
 * CSS 変数の実体値を getComputedStyle から取得する。色の明暗操作・補間など
 * `var(...)` 文字列では扱えない処理向け。解決不能時はフォールバックを返す。
 */
export function resolveVar(name: string, el?: Element | null): string {
  const varName = name.startsWith("--") ? name : `--${name}`;
  const fallback = FALLBACKS[varName] ?? "#000000";
  if (typeof window === "undefined" || typeof getComputedStyle === "undefined") {
    return fallback;
  }
  const target = el ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!target) return fallback;
  const val = getComputedStyle(target).getPropertyValue(varName).trim();
  return val || fallback;
}

/** インデックス i を実体色に解決（明暗操作が必要なチャート用） */
export function resolveChartColor(index: number, el?: Element | null): string {
  const n = (((index % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE) + 1;
  return resolveVar(`--chart-${n}`, el);
}

/**
 * チャートで頻用する意味づけ色（すべて `var(...)` 文字列＝テーマ追従）。
 * DashMock 時代の `--color-*` 独自トークンはここへ写像する:
 *   --color-text-primary   → CHART_TEXT
 *   --color-text-secondary → CHART_TEXT_MUTED
 *   --color-border         → CHART_BORDER
 *   --color-background     → CHART_SURFACE
 */
export const CHART_TEXT = token("--foreground");
export const CHART_TEXT_MUTED = token("--muted-foreground");
export const CHART_BORDER = token("--border");
export const CHART_SURFACE = token("--card");
export const CHART_POSITIVE = token("--chart-positive");
export const CHART_NEGATIVE = token("--chart-negative");
export const CHART_WARNING = token("--chart-warning");

/** 軸ラベルの既定フォントサイズ（shadcn トークンに無いので固定 px） */
export const CHART_AXIS_FONT_SIZE = "11px";
