// 配色統一の再発防止ガード（構造テスト）。
// ・チャート描画で SVG の paint 属性に生 hex を直書きしない（色はトークン/ロール経由）。
//   例外: 白抜きテキスト #fff/#ffffff、var(...) のフォールバック（var(--x, #hex)）。
// ・軸を持つチャート（d3.axisBottom/Left）は themeAxis を必ず使う（軸の色を直書きしない）。
// サンプルデータ定数（DEFAULT_* の color: "#..."）は data であって描画直書きではないので対象外。
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CHARTS_DIR = dirname(fileURLToPath(import.meta.url));
const chartFiles = readdirSync(CHARTS_DIR).filter(
  (f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"),
);

// .attr("fill"|"stroke"|"stop-color", "#rrggbb")  / .style("fill", "#rrggbb") を検出（#fff系は許可）
const RAW_HEX_PAINT =
  /\.(attr|style)\(\s*["'](?:fill|stroke|stop-color)["']\s*,\s*["']#(?!fff\b|ffffff\b)[0-9a-fA-F]{6}/g;

describe("チャート配色の統一ガード", () => {
  it("SVG の paint 属性に生 hex を直書きしていない（色はトークン/ロール経由）", () => {
    const offenders: string[] = [];
    for (const f of chartFiles) {
      const src = readFileSync(join(CHARTS_DIR, f), "utf8");
      const m = src.match(RAW_HEX_PAINT);
      if (m) offenders.push(`${f}: ${m.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("軸を持つチャートは themeAxis を使う（軸の色を直書きしない）", () => {
    const offenders: string[] = [];
    for (const f of chartFiles) {
      const src = readFileSync(join(CHARTS_DIR, f), "utf8");
      const hasAxis = /axisBottom|axisLeft|axisRight|axisTop/.test(src);
      if (hasAxis && !/themeAxis/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  // flicker 再発防止: tooltip は命令的(ref)方式のみ。props版(<ChartTooltip x=…>)や
  // 旧 state 変数(tooltipState)を使うと setState→再レンダー→useD3再実行→flicker が復活する。
  it("ChartTooltip は ref 方式のみ（props版/tooltipState を使わない）", () => {
    const offenders: string[] = [];
    for (const f of chartFiles) {
      const src = readFileSync(join(CHARTS_DIR, f), "utf8");
      if (/<ChartTooltip\s+x=/.test(src) || /\btooltipState\b/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  // 角丸は SHAPE_RX に一本化（rx の数値直書き≥1 を禁止。rx 0 は円形化などで可）。
  it("filled shape の角丸は SHAPE_RX を使う（rx の数値直書き≥1 を禁止）", () => {
    const offenders: string[] = [];
    for (const f of chartFiles) {
      const src = readFileSync(join(CHARTS_DIR, f), "utf8");
      const m = src.match(/\.attr\(\s*["']rx["']\s*,\s*[1-9]/g);
      if (m) offenders.push(`${f}: ${m.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
