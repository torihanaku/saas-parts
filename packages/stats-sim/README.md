# @torihanaku/stats-sim

シナリオ予測のモンテカルロシミュレーション（p5/p50/p95分布）と、MMM（マーケティングミックスモデル）結果からの弾力性テーブル抽出＋因果実験オーバーライドを行う純粋アルゴリズム集。

## 主要API

### モンテカルロ（`runMonteCarlo`）

ベースラインのノイズとモデル不確実性（弾力性係数の±10%ガウス摂動）の両方を伝播させて、出力指標ごとの経験分布（mean / std / p5 / p50 / p95）を返す。

```ts
import { runMonteCarlo, makeRng } from "@torihanaku/stats-sim";

const dist = runMonteCarlo({
  baseline: {
    pv: { mean: 1000, std: 100 },
    cv: { mean: 20, std: 4 },
    blog_count: { mean: 4, std: 0 },
  },
  scenarioInputs: { blog_count: 8 },            // ユーザーが動かす入力
  elasticities: { blog_count: { pv: 150, cv: 3 } },
  trials: 1000,                                  // 1〜10000にクランプ
  seed: 42,                                      // 決定的（デフォルト42）
  // rng: makeRng(42),                           // または RNG を直接注入（seedより優先）
});
// dist.pv => { mean, std, p5, p50, p95 }
```

### 弾力性抽出（`extractElasticitiesFromMmm` / `extractElasticitiesWithCausalPreference`）

データは全て引数渡し（DB取得は呼び出し側の責務）。セル単位の優先順位: **因果リンク > MMM beta > フォールバック定数**。

```ts
import {
  extractElasticitiesFromMmm,
  extractElasticitiesWithCausalPreference,
  type MmmResultRow,
  type CausalToTwinLink,
} from "@torihanaku/stats-sim";

// 最新のMMM結果行（無ければ null → FALLBACK_ELASTICITIES を使用）
const mmmRow: MmmResultRow = {
  channels: [{ channel: "google_ads", beta: 0.42 }],
  saturation_form: "hill", // hill/weibull は「局所勾配のみ」の警告が付く
};

// DID/合成対照/RCT の効果量でMMM betaを上書き（provenance付き）
const links: CausalToTwinLink[] = [
  { experimentId: "exp-9", channel: "google_ads", outputMetric: "revenue", effectSize: 1.5 },
];
const res = extractElasticitiesWithCausalPreference(mmmRow, links);
// res.table                => inputKey -> { pv/cv/revenue -> 係数 }
// res.causalProvenance     => 上書きセルごとの experiment_id（UIで「出所: DID 実験 #XX」）
// res.warnings / formHint / fromMmm / hasCausalOverride
```

## 注入ポイント

- **RNG**: `MonteCarloInput.rng`（`() => number`）を注入可能。省略時は `makeRng(seed ?? 42)`（mulberry32・完全決定的）
- **データ**: MMM結果行（`MmmResultRow | null`）と因果リンク（`CausalToTwinLink[]`）は呼び出し側がDB等からロードして渡す。元実装のSupabase取得・staleness判定（90日）は呼び出し側の責務（`stale`/`ageDays` フラグで受け渡し）
- **フォールバック**: MMM欠損時は `FALLBACK_ELASTICITIES`（blog_count/ad_budget/email_frequency）を使用し warnings で通知

## Runtime

- 依存ゼロ・純粋計算のみ。Node / Bun / ブラウザいずれでも動作
- 性能: 1000 trials × 10出力 × 5入力 ≒ 50k乗算 / 呼び出しで実測 <50ms

## 出典

- `実運用SaaS/server/lib/twin/monte-carlo.ts`（#1360）
- `実運用SaaS/server/lib/twin/elasticity-extractor.ts`（#1307/#1324）＋ `causal-link.ts` の純粋部分（`channelToInputKey`/`buildCausalElasticityTable`）
- 変更点: Supabase取得を撤去し引数渡しの純粋関数化（async→sync）。型は最小限をローカル定義。`rng` 直接注入を追加
