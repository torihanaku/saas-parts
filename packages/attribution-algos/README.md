# @torihanaku/attribution-algos

マルチタッチアトリビューション（広告・チャネル貢献度配分）の純粋アルゴリズム集。
Markov 連鎖の除去効果（removal effect）法と Shapley 値法に加え、
ファーストタッチ / ラストクリック / 線形のルールベース配分も含む。

## 用途

- ユーザーごとのタッチポイント履歴（journey）から、チャネル／キャンペーン別のコンバージョン貢献度を算出する
- 複数モデル（first-touch / last-click / linear / Shapley / Markov）を並べて比較するマーケティングROI分析

## API 例

```ts
import {
  buildConversionPaths,
  calculateMarkovAttribution,
  calculateShapleyAttribution,
  baseAttributionRows,
  mergeModelCredits,
  type Touchpoint,
} from "@torihanaku/attribution-algos";

const touchpoints: Touchpoint[] = [
  { userHash: "u1", channel: "meta",  campaignId: "m1", touchedAt: "2026-05-01T00:00:00Z", valueJpy: 0,      metadata: {} },
  { userHash: "u1", channel: "email", campaignId: "e1", touchedAt: "2026-05-01T00:01:00Z", valueJpy: 0,      metadata: {} },
  { userHash: "u1", channel: "conversion", campaignId: null, touchedAt: "2026-05-01T00:02:00Z", valueJpy: 10000, metadata: { event_type: "conversion" } },
];

const paths = buildConversionPaths(touchpoints);          // ユーザー別 journey に集約
const markov = calculateMarkovAttribution(paths);          // Map<"channel::campaignId", credit>
const shapley = calculateShapleyAttribution(paths);

// ルールベース3モデル + モデル別クレジットを1テーブルに統合
let rows = baseAttributionRows(paths);
rows = mergeModelCredits(rows, "conversionsShapley", shapley);
rows = mergeModelCredits(rows, "conversionsMarkov", markov);
```

## 入出力データ形状

- **入力**: `Touchpoint[]`（1イベント1行）
  - `userHash`: 匿名化ユーザーID（この値で journey をグルーピング）
  - `channel` / `campaignId`: 貢献先キーは `"${channel}::${campaignId ?? channel}"`
  - `touchedAt`: ISO 8601 タイムスタンプ（journey は時刻昇順ソート）
  - `valueJpy > 0`、`channel === "conversion"`、`metadata.event_type === "conversion"`、`metadata.conversion === true` のいずれかでコンバージョンイベント扱い
  - `metadata.spend_jpy`（または `spend`）があれば `baseAttributionRows` の spend に集計
- **出力**:
  - Markov / Shapley: `Map<string, number>`（キー = `"channel::campaignId"`、値 = 配分されたコンバージョン数）
  - `baseAttributionRows`: `AttributionRow[]`（first/last/linear + spend、linear 降順ソート）

## アルゴリズム

- **Markov**: journey を START → チャネル列 → CONVERSION/NULL の状態遷移列とみなし、遷移頻度から全体のコンバージョン確率を計算。各チャネルを取り除いたときの確率低下（removal effect）に比例して総コンバージョン数を配分する
- **Shapley**: 各コンバージョン journey 内のユニークチャネルへ均等配分（対称な特性関数に対する Shapley 値の閉形式解）

## Runtime

- 依存なし（純粋 TypeScript）。Node / Bun / ブラウザいずれも可
- `process.env`・I/O 一切なし

## 出典

- 実運用SaaS `server/lib/marketing-roi/markov.ts` / `shapley.ts` / `attribution.ts`
- 移植時の変更: DB行マッピング `toTouchpoint` と `id` / `tenantId` フィールド（製品側の配管）を削除。数値ロジックは原文どおり
