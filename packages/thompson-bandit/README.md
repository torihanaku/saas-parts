# @torihanaku/thompson-bandit

A/Bテストのバリアント割当をThompsonサンプリング（Beta事後分布からの乱択）で行う純粋バンディット数学。DB・サービス層に依存しない。

## 主要API

```ts
import {
  thompsonAllocate,
  posteriorBestProbability,
  uniformAllocate,
  sampleBeta,
  type BetaVariant,
} from "@torihanaku/thompson-bandit";

// alpha = 成功数+1, beta = 失敗数+1（Beta事後）
const variants: BetaVariant[] = [
  { id: "control", alpha: 12, beta: 88 },
  { id: "treatment", alpha: 25, beta: 75 },
];

// 1回の割当（事後サンプル最大のバリアントを選ぶ）
const { variantId, source, probability } = thompsonAllocate(variants);
// => { variantId: "treatment", source: "thompson", probability: <sampled posterior> }

// 「treatmentが最良である事後確率」（勝者判定に使う。デフォルト2000ドロー）
const pBest = posteriorBestProbability(variants, "treatment");

// 一様割当（epsilon-greedy / フォールバック用）
const fallback = uniformAllocate(variants);

// Beta(α, β) から1サンプル（Gamma 2本経由・Marsaglia & Tsang法）
const s = sampleBeta(2, 5);
```

## 注入ポイント

- **RNG注入**: 全関数が末尾引数 `rand: () => number` を受け取る（デフォルト `Math.random`）。シード付きPRNG（mulberry32等）を渡せば完全決定的になり、テスト・リプレイが可能
- **ドロー数**: `posteriorBestProbability` の `draws` 引数（デフォルト `BANDIT_DEFAULTS.POSTERIOR_DRAWS` = 2000）
- データ（alpha/beta）は呼び出し側が集計して渡す。試行/成功カウントの永続化はこのパッケージの責務外

## Runtime

- 依存ゼロ・純粋計算のみ。Node / Bun / ブラウザいずれでも動作

## 出典

- `dev-dashboard-v2/server/lib/ab-testing-bandit.ts`（#362）の忠実移植
- 変更点: `shared/types/ab-testing` の `AllocationResult` をローカル定義にインライン化。`BetaVariant` 型を命名エクスポート化
