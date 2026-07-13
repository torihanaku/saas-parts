# @torihanaku/ab-significance

A/B テストの勝者判定を行うベイズ有意性テスト。
各バリアントのコンバージョン率を Beta(α, β) 事後分布で表し、
95% 信用区間（credible interval）の非重なりで勝者を宣言する純粋アルゴリズム。

> **ペア利用**: 配信比率の最適化（Thompson sampling による allocation）は
> `@torihanaku/thompson-bandit` が担当。本パッケージは「実験を止めてよいか」の
> 判定側で、両者に import 依存はない。

## 用途

- A/B/n テストの自動勝者判定（勝者確定 / 継続 / サンプル不足の3値）
- Beta 分布の分位点・信用区間の軽量近似計算（scipy / jstat 不要）

## API 例

```ts
import { decideSignificance, betaCredibleInterval } from "@torihanaku/ab-significance";

// alpha = 成功数 + 1, beta = 失敗数 + 1 (一様事前分布の場合)
const result = decideSignificance(
  [
    { id: "control", alpha: 120, beta: 880, impressions: 1000 },
    { id: "variant", alpha: 180, beta: 820, impressions: 1000 },
  ],
  100,   // minImpressions (default 100)
  0.95,  // 信用区間の確率 (default 0.95)
);
// result.status  → "winner" | "still_running" | "insufficient_samples"
// result.winnerId → "variant" など
// result.intervals → 各バリアントの { id, mean, ciLower, ciUpper }

const ci = betaCredibleInterval(100, 200); // { mean, lower, upper }
```

## 入出力データ形状

- **入力**: `BetaPosterior[]` — `{ id, alpha, beta, impressions }`（alpha, beta > 0）
- **出力**: `SignificanceResult` — `{ status, winnerId, intervals, reason }`
  - 判定ルール: 全バリアントが `minImpressions` 以上 → 事後平均最大のバリアントが候補 →
    候補の CI 下限が他全員の CI 上限を上回れば `winner`、重なれば `still_running`

## 数値計算

- probit（標準正規分布の逆CDF）: Acklam の有理近似（誤差 ~1.15e-9）
- Beta 分位点: 正規近似 `μ + σ·z`（中程度の α, β で十分な精度。α, β が極端に小さい場合は精度が落ちる）

## Runtime

- 依存なし（純粋 TypeScript）。Node / Bun / ブラウザいずれも可
- `process.env`・I/O 一切なし・決定的（乱数なし）

## 出典

- 実運用SaaS `server/lib/ab-testing/significance.ts`（#1357）
- 移植時の変更: なし（コメント内の社内ファイル参照を `@torihanaku/thompson-bandit` への言及に置換したのみ。数値ロジックは原文どおり）
