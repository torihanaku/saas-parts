# @torihanaku/kit-dashboard

テーマ非依存の**ダッシュボード / チャート UI キット**。D3 ベースの高度チャート群
（サンキー・地図・ウォーターフォール・ファネル・ゲージ・箱ひげ 等、recharts では
描けないもの中心）＋ダッシュボード外殻（KPI スコアカード・フィルタ・グリッド）を、
どの SaaS にも差し込める形で提供する。

## 設計原則：色をハードコードしない

チャートの色・面・境界・文字は**すべて shadcn/ui の CSS 変数**を参照する。
SVG の `fill`/`stroke` に `var(--chart-1)` 形式で直接埋め込むため、**ダークモード
切替時に React 再描画なしで色が追従**する。特定のルックを押し付けないので、
saas-parts の「見た目コンポーネントは共有しない（＝ブランド固有ルックを持ち込まない）」
方針とも衝突しない。

参照する変数:

| 変数 | 用途 |
|------|------|
| `--chart-1` .. `--chart-8` | シーケンシャル配色（shadcn は 1..5、6..8 は本キットの追加） |
| `--chart-positive` / `--chart-negative` / `--chart-warning` | トレンド（増減）色 |
| `--foreground` / `--muted-foreground` | 文字（主／副） |
| `--border` | 軸・グリッド線 |
| `--card` / `--popover` / `--popover-foreground` | 面・ツールチップ |

## 取り込み方

```ts
// 1) テーマ変数の既定値を供給（ホストの globals.css を後に読めばホスト値が優先）
import "@torihanaku/kit-dashboard/theme.css";

// 2) コンポーネントを使う
import { getChartColor, useResizeObserver } from "@torihanaku/kit-dashboard";
```

saas-parts 流の取り込み（`file:` 参照 / vendoring / bun link）が主。将来的に
`registry.json` を用意すれば `npx shadcn add <URL>` でのコピー注入にも対応予定。

## peerDependencies

- `react >= 18`（必須）
- `d3 >= 7`（チャート描画。必須）
- `d3-sankey >= 0.12`（Sankey 使用時のみ・optional）
- `topojson-client >= 3`（地図系使用時のみ・optional）
- `react-grid-layout >= 1.4`（DashboardGrid 使用時のみ・optional）

## 収録

- **高度チャート（recharts で描けないもの中心）**: `SankeyChart` / `GeoChart` / `BubbleMapChart` /
  `WaterfallChart` / `FunnelChart` / `GaugeChart` / `TreemapChart` / `BoxplotChart` /
  `CandlestickChart` / `BulletChart` / `HeatmapChart` / `HistogramChart` / `PivotTable`
- **基本チャート**: `BarChart` / `LineChart` / `AreaChart` / `PieChart` / `ComboChart` /
  `ScatterChart` / `BubbleChart` / `TableChart` / `ScoreCard` / `TimelineChart` / `WordCloudChart`
- **フィルタ（全て value + onChange の制御コンポーネント・状態は消費側が管理）**:
  `FilterDropdownWidget` / `FilterCheckboxWidget` / `FilterListWidget` / `FilterSliderWidget` /
  `FilterInputWidget` / `FilterDateWidget` / `FilterResetWidget` / `DateRangePicker` / `FilterBar`
- **外殻 / レイアウト**: `DashboardGrid`（D&D は `gridComponent` に react-grid-layout を注入）/
  `SectionHeader` / `TextBox` / `ReportHeaderWidget`
- **プリミティブ**: `ChartTooltip` / `Dropdown` / `Badge`
- **共通ランタイム**: `useD3` / `useResizeObserver` / `useTooltip` / `useSort` /
  `d3Helpers` / `formatters` / `colorUtils`（CSS 変数解決）/ `theme`（`token` / `chartColorVar` / `resolveVar`）

すべてのチャートは既定サンプルデータを持つので `<WaterfallChart />` のように**ゼロ設定で描画**できる
（実データは `data` 等の props で差し込む）。
