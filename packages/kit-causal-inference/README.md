# @torihanaku/kit-causal-inference

因果推論エンジン — 実運用SaaS から抽出した純粋 TypeScript の統計計算コア。
入力はプレーンな配列・オブジェクトのみ。I/O・環境変数・DB アクセスは一切なし。

```ts
import { runDid, runRdd, runPsm, runMmm, detectChangePoints } from "@torihanaku/kit-causal-inference";
```

## 収録手法

### 1. DID — 差分の差分法（`runDid`）

処置群・対照群それぞれの前後差の差でキャンペーン効果を推定する。両群 30 以上のサンプルが必要（未満なら `effectSize: null` + 警告）。並行トレンド仮定は検証せず `assumptions` で明示する。

```ts
const res = await runDid({
  treatmentGroup: [{ entityId: "t1", preOutcome: 100, postOutcome: 120 }, /* ×30以上 */],
  controlGroup:   [{ entityId: "c1", preOutcome: 100, postOutcome: 103 }, /* ×30以上 */],
  confidenceLevel: 0.95, // 0.90 / 0.95 / 0.99
});
// → { effectSize, stdError, pValue, ciLower, ciUpper, sampleSize, assumptions, warnings }
```

### 2. PSM — 傾向スコアマッチング（`runPsm`）

ロジスティック回帰（勾配降下・早期停止）で傾向スコアを推定し、貪欲 1:1 最近傍マッチング（キャリパー 0.2）で ATT を計算する。

```ts
const res = await runPsm({
  treatmentGroup: [{ entityId: "t1", covariates: [0.5, 0.3], outcome: 80 }, /* ×30以上 */],
  poolGroup:      [{ entityId: "p1", covariates: [0.4, 0.4], outcome: 55 }, /* 処置群以上の数 */],
});
// → { effectSize (ATT), stdError, pValue, ciLower, ciUpper, ... }
```

### 3. Sharp RDD — 回帰不連続デザイン（`runRdd` / `silvermanBandwidth`）

カットオフの左右で局所線形回帰を別々にフィットし、カットオフ上の予測値の差を局所処置効果として推定する。バンド幅未指定時は Silverman 経験則（h = 1.06·σ·n^(−1/5)）。

```ts
const res = await runRdd({
  observations: [{ x: -1.2, y: 10.5 }, /* ... */],
  cutoff: 0,
  bandwidth: 2,        // 省略時 Silverman
});
// → { effect, seEstimate, ciLow, ciHigh, nLeft, nRight, bandwidth, bandwidthMethod, ... }
```

### 4. IK 最適バンド幅（`imbensKalyanaramanBandwidth`）

Imbens–Kalyanaraman (2012) の MSE 最適バンド幅。密度・分散・曲率をパイロット窓で推定し、条件を満たさないデータでは Silverman に自動フォールバック（`method` と `warnings` で判別可能）。

### 5. Fuzzy RDD — 2SLS/Wald 推定（`runFuzzyRdd`）

処置の受け入れ（take-up）がカットオフで不完全にジャンプする場合の LATE 推定。reduced-form のジャンプ ÷ first-stage のジャンプ（コンプライアンス率）。first-stage が弱い場合は `weak_first_stage` 警告と `effect: null`。

```ts
const res = await runFuzzyRdd({
  observations: [{ x: -1.2, y: 10.5, d: 0 }, /* d = 処置受け入れ（0/1 または割合） */],
  cutoff: 0,
});
// → { effect (LATE), complianceRate, reducedFormJump, ... }
```

### 6. 変化点検知 — BOCD（`detectChangePoints`）

Adams & MacKay (2007) の Bayesian Online Change Point Detection。時系列のレジームシフト（自然実験の候補）を事後確率つきで検出し、後続分析（did / rdd / inspect_only）のヒントを返す。

```ts
const res = detectChangePoints({ values: dailyRevenue, hazard: 0.01, threshold: 0.5, minGap: 7 });
// → { changePoints: [{ index, probability, preMean, postMean, effectSize, recommendation }], changeProbabilities, ... }
```

### 7. MMM — メディアミックスモデリング（`runMmm` ほか）

チャネル毎に geometric adstock（`geometricAdstock`）＋ Hill/Weibull 飽和カーブ（`saturate`）を適用し、グリッドサーチ＋ Metropolis-Hastings（決定的シード、`bayesianFit`）で係数を推定する。貢献度・ROI・飽和点・飽和カーブ座標まで算出。

```ts
const res = await runMmm({
  y: revenueSeries,                                     // 長さ T
  channels: [{ channel: "tv", spend: tvSpendSeries }],  // 各 spend も長さ T
  saturationForm: "hill",  // 省略時 hill
  seed: 42,                // 再現性のための乱数シード
});
// → { channels: [{ adstockRate, beta, contribution, roi, saturationPoint, saturationCurve }], rSquared, ... }
```

### 8. 反実仮想推定（`estimateCounterfactual`）

「介入がなかったら」を前期間平均の射影で近似し、実績との相対リフトと 95% CI を返す。

```ts
const res = estimateCounterfactual({ preValues: [/* 前期間 */], postValues: [/* 介入後 */] });
// → { actual, counterfactual, lift (相対), ci: [low, high] (絶対リフトのCI) }
```

### 9. 自然実験（外生ショック）検出（`detectExogenousShocks`）

日次系列を走査し、直近 21 期間ベースラインから 3σ 超の急落を検出。各ショックに DID 用の pre/post 窓を提案する。

```ts
const shocks = detectExogenousShocks([{ date: "2026-01-01", value: 1200 }, /* 昇順 */]);
// → [{ shockDate, liftEstimate, prePeriodStart, prePeriodEnd, postPeriodStart, postPeriodEnd, ... }]
```

### 10. 検定力分析（`designTest`）

二標本比率のパワー計算。ベースライン CVR と期待相対リフトから必要サンプルサイズと実験日数を算出する。

```ts
const design = designTest({ metric: "conversion", baseline: 0.05, expectedLift: 0.10 });
// → { sampleSizePerGroup: 31196, totalSampleSize: 62392, suggestedDurationDays: 63, splitRatio: [0.5, 0.5] }
```

### 11. MAPE 追跡・ドリフト検知（`computeMape` / `computeBaselineMape` / `detectMapeDrift`）

ナイーブ予測（ベースライン窓の平均）に対する APE の計算と、グループ平均 MAPE > 30% の「再学習推奨」判定。

```ts
computeBaselineMape([1100], [1000, 1000]); // → { actualValue: 1100, predictedValue: 1000, mape: 0.0909 }
detectMapeDrift([{ groupId: "t1", mape: 0.4 }]); // → [{ groupId: "t1", avgMape: 0.4, sampleCount: 1 }]
```

### 12. What-If シナリオ（`simulateWhatIf` / `exportToCsv`）

シナリオ係数（悲観 0.8 / 現実 1.0 / 楽観 1.2）と信頼水準マッピング（0.6 / 0.8 / 0.95）。予測コア自体は同梱せず、コールバックで注入する（下記）。

## 注入ポイント（依存性注入）

- **予測シミュレータ**: `simulateWhatIf({ inputs, scenario, simulate })` の `simulate` に、
  `@torihanaku/stats-sim` の Monte-Carlo シミュレータ等、`CoreSimulateFn` 互換の関数を渡す。
  本キットはシナリオ係数の適用と入出力整形のみを担う。
- **ドリフト時のアラート**: 元実装は Sentry 通知＋イベント INSERT を行っていたが、本キットは
  `detectMapeDrift` の戻り値（ドリフトしたグループ一覧）を返すだけ。通知は呼び出し側で実装する。
- **LLM 解釈**: 収録した計算コアに LLM 呼び出しは元々存在しない（解釈文の生成が必要な場合は
  呼び出し側で結果オブジェクトを LLM に渡す設計を推奨）。

## 落としたもの（理由つき）

| 落としたもの | 元の場所 | 理由 |
|---|---|---|
| Hono ルート 8 本（認可・zod 検証・Supabase 保存・feature flag） | `server/routes/causal/*` | HTTP/認可/永続化は製品側の責務。計算は全て lib 側に存在し本キットへ移植済み |
| Supabase からのデータ取得・期間切り出し | `counterfactualAnalyzer.ts` / `naturalExperimentDetector.ts` | 「呼び出し側が配列を渡す」方針。数値計算は忠実に維持 |
| `dd_natural_experiments` への重複チェック＋INSERT、固定 p_value(0.05) | `naturalExperimentDetector.ts` | 永続化は呼び出し側。p_value はプレースホルダ定数だったため削除 |
| Redis キャッシュ＋SHA-256 キャッシュキー | `whatIfSimulator.ts` | インフラ依存。必要なら呼び出し側でメモ化 |
| コア予測シミュレータ（twin/simulator-service） | `whatIfSimulator.ts` | **`@torihanaku/stats-sim` として別キット化**（monte-carlo.ts / elasticity-extractor.ts を含む）。本キットには含めない |
| Sentry 通知・`dd_events` INSERT・logger | `jobs/mape-drift-check.ts` / `whatifMapeTracker.ts` | 副作用は呼び出し側。閾値 30%・4桁丸め等の数値ロジックは移植済み |
| `MmmResultRow`（Supabase テーブル行型） | `shared/types/causal-mmm.ts` | DB スキーマは製品側の責務 |
| ルート経由のスモークテスト（401/400/422 等） | `tests/causal-rdd.test.ts` / `mmm-route.test.ts` / `causal-route.test.ts` ほか | HTTP 配線のテスト。計算のゴールデンテストは全件移植済み |
| `tenantId` / `experimentId` の必須化 | `DidInput` / `PsmInput` | キットではオプショナルなメタデータに変更（統計計算には不使用） |

## 出典（収録元ファイル）

すべて 実運用SaaS（読み取り専用ソース）から。数値は変更していない。

- `server/lib/causal/stats-utils.ts` → `src/stats.ts`
- `server/lib/causal/did-service.ts` → `src/did.ts`
- `server/lib/causal/psm-service.ts` → `src/psm.ts`
- `server/lib/causal/rdd-service.ts` → `src/rdd.ts`
- `server/lib/causal/rdd/bandwidth.ts` → `src/rdd-bandwidth.ts`
- `server/lib/causal/rdd/fuzzy.ts` → `src/rdd-fuzzy.ts`
- `server/lib/causal/change-point-detection.ts` → `src/change-point.ts`
- `server/lib/causal/mmm/{adstock,saturation,bayesian-fit,index}.ts` → `src/mmm-{adstock,saturation,bayesian-fit}.ts` / `src/mmm.ts`
- `shared/types/causal-mmm.ts` → `src/mmm-types.ts`
- `server/services/counterfactualAnalyzer.ts` → `src/counterfactual.ts`
- `server/services/naturalExperimentDetector.ts` → `src/natural-experiment.ts`
- `server/services/incrementalityDesignAgent.ts`（routes/causal/design-test.ts 経由で公開されていた計算） → `src/design-test.ts`
- `server/services/whatIfSimulator.ts` + `shared/types/whatif.ts` → `src/whatif.ts`
- `server/jobs/whatifMapeTracker.ts` / `server/jobs/mape-drift-check.ts` → `src/mape.ts`
- テスト: `tests/causal/gold-standard/*`（ゴールデン12ケース）、`tests/causal-rdd.test.ts`、`tests/server/lib/causal/**`、`tests/counterfactual-analyzer.test.ts`、`tests/whatif-mape-tracker.test.ts`、`tests/server/whatif-{simulator,export}.test.ts` ほか → `src/*.test.ts`

## 検証

```bash
npx tsc --noEmit -p packages/kit-causal-inference/tsconfig.json
npx vitest run packages/kit-causal-inference   # 119 tests
```
