# @torihanaku/scenario-twin

施策シナリオの**デジタルツイン**です。ベースラインを構築し、シナリオをシミュレーション、複数シナリオ比較、感度分析（スイープ）、予測のバックテスト、因果実験の効果量を弾力性へ橋渡しします。実運用SaaS（Epic B5, `server/lib/twin/*`）の実装を移植し、数値計算と永続化を差し込み式にして自己完結化しました。

## 設計

- **モンテカルロ／弾力性抽出は差し込み式**（`TwinMath`）: `runMonteCarlo` と `extractElasticities` を注入します。`@torihanaku/stats-sim` がこのインターフェイスを満たします（import はしていません）。
- **永続化は差し込み式**（`TwinStore`）: ベースライン・シミュレーション・バックテスト・感度ランの読み書きを抽象化。Supabase / Postgres / インメモリなどのアダプタを実装します。
- **オーケストレーション同士も疎結合**: `compare` / `analyzeSensitivity` は `simulate` 関数を引数で受け取ります。因果リンク（`saveCausalToTwinLink` / `getTenantCausalLinks`）は `CausalLinkStore` を注入します。

## 対になるパッケージ

- `@torihanaku/stats-sim` — モンテカルロ・弾力性抽出を提供し、本パッケージの `TwinMath` インターフェイスを構造的に満たします（利用側で束ねてください）。

## 使い方

```ts
import { simulate, compare, analyzeSensitivity, buildBaseline } from "@torihanaku/scenario-twin";

const deps = { store: myTwinStore, math: myTwinMath };

// ベースライン構築
await buildBaseline(tenantId, myTwinStore, 90);

// シミュレーション（simulate を部分適用してオーケストレーターに渡す）
const runSim = (input) => simulate(input, deps);
const sim = await runSim({ tenantId, scenarioName: "案A", scenarioInputs: { ad_budget: 150 } });

// 比較
const cmp = await compare({ tenantId, scenarios: [{ name: "A", inputs: {} }, { name: "B", inputs: {} }] }, runSim);

// 感度分析
const sens = await analyzeSensitivity({ tenantId, baseScenario: { ad_budget: 100 } }, runSim);
```

### 因果 → ツイン弾力性ブリッジ

DID / 合成コントロール / RCT の効果量は、相関ベースの MMM 係数より信頼できる弾力性推定です。`buildCausalElasticityTable` で `{ inputKey -> { outputMetric -> 弾力性 } }` を構築し、90 日超の古いリンクは stale としてフラグします。

### クライアントフック（React）

`src/client/useTwin.ts` に `useTwinSimulate` / `useTwinCompare` / `useTwinSensitivity` / `useTwinBacktest` / `useTwinBaseline` があります。HTTP クライアント（`{ get, post }`）を注入します。`react` は peer dependency です。

## テスト

- `baseline-builder.test.ts` — 統計計算 / fail-closed
- `simulator-service.test.ts` — 弾力性適用 / モンテカルロ重ね合わせ / 劣化
- `comparison-service.test.ts` — 2〜3 シナリオ比較
- `sensitivity-service.test.ts` — ±X% / マルチステップ / 永続化
- `backtest-service.test.ts` — MAPE / RMSE / MAE
- `causal-link.test.ts` — チャネル写像 / stale 判定 / 弾力性テーブル
- `client/useTwin.test.tsx` — React フック（jsdom）
