# @torihanaku/forecast-engines

日次時系列の予測エンジン集。共通インターフェース `ForecastEngine` の背後に
3エンジン（移動平均 / ARIMA(1,1,1) 近似 / 季節回帰）を持ち、
データ量に応じた自動選択セレクタ付き。純粋 TypeScript・依存ゼロ。

## 用途

- 広告費・CV数・売上などの日次系列を N 日先まで予測し、信頼区間つきで返す
- データ蓄積量（30日未満 / 30-90日 / 90-180日 / 180日以上）に応じたエンジン自動切替

## API 例

```ts
import { defaultEngineSelector, ProphetEngine, arimaEngine } from "@torihanaku/forecast-engines";

const series = [
  { date: "2026-01-01", value: 120 },
  { date: "2026-01-02", value: 135 },
  // ... 古い → 新しい順の日次データ
];

// データ日数で自動選択（30日未満は null → 呼び出し側でエラー表示）
const engine = defaultEngineSelector.pickEngine(series.length);
if (!engine) throw new Error("30日以上のデータが必要です");

const result = await engine.forecast({
  series,
  horizonDays: 14,        // 14日先まで
  confidenceLevel: 0.95,  // default 0.95
});
// result: { forecast: number[], confidenceLower: number[], confidenceUpper: number[],
//           confidenceLevel, method, reason? }
```

## 入出力データ形状

- **入力** `ForecastParams`: `series: { date: string; value: number }[]`（古い→新しい順の日次系列）、`horizonDays`、`confidenceLevel?`
- **出力** `ForecastResult`: horizon 日分の `forecast` / `confidenceLower` / `confidenceUpper`（負値は 0 にクランプ）＋ `method`・`reason`

## エンジンと自動選択（`defaultEngineSelector`）

| データ日数 | エンジン | 手法 |
|---|---|---|
| < 30 | `null`（明示エラー） | — |
| 30–89 | `movingAverageEngine` | 全期間平均 + ランダムウォーク型の広い信頼区間（√i で拡大） |
| 90–179 | `arimaEngine` | ARIMA(1,1,1) 近似 = 1階差分に対する lag-1 最小二乗 AR |
| ≥ 180 | `ProphetEngine`（`seasonal_regression`） | 線形トレンド + 曜日季節性 + 減衰自己回帰残差 |

## Prophet について（重要）

`ProphetEngine` は **Meta の Prophet ライブラリを使っていません**。名前は元リポジトリの
ロードマップ由来で、実体は Node 内で完結する季節回帰近似（線形トレンド＋曜日別残差平均＋
減衰係数 0.65 の AR 残差）です。`method` は `"seasonal_regression"` を返します。
そのままの挙動で移植しています。

同様に、`arimaEngine` が元々依存していた npm `timeseries-analysis` は degree=1 でしか
使われていなかったため、等価な閉形式（`Σv[i+1]·v[i] / Σv[i]²` と母標準偏差）を
`ar-least-square.ts` にインライン化し、依存ゼロにしました（数値は同一）。

## Runtime

- 依存なし（純粋 TypeScript）。Node / Bun / ブラウザいずれも可
- `process.env`・I/O なし（推奨日数未満時の `console.warn` のみ）

## 出典

- 実運用SaaS `server/lib/forecast/`（arima-engine / prophet-engine / moving-average-engine / engine-selector / forecast-engine）
- 移植時の変更: ① `timeseries-analysis` 依存を等価実装でインライン化 ② `ForecastResult` を `shared/types/marketing.ts` からインライン化（`method` を `string` に拡大 — 元の union に `seasonal_regression` が含まれていなかったため）。数値ロジックは原文どおり
