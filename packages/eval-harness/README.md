# @torihanaku/eval-harness

LLM／分類器の汎用評価ハーネスです。ゴールデンケース（入力 → 期待判定）をジャッジ（LLM・ルールエンジン等、注入コールバック）に流し、precision / recall / F1 / accuracy を算出、しきい値違反の検出、ラン間のリグレッション比較までを純粋関数中心で提供します。

構成要素:

- **metrics** — 混同行列・分類指標・MAPE に加え、埋め込みコサイン類似度ベースの「repeat-catch rate」（類似の再出現を 2 回目以降に自動検知できた率＝学習の効き）と「override retention rate」（人間が承認済みのパターンを再度フラグし続ける率＝過学習シグナル）
- **golden** — ゴールデンケースランナー（ジャッジ注入、ケース単位の pass/fail と失敗一覧、エラーは握りつぶさず errored ケースとして可視化）
- **runner** — KPI 一括計算＋しきい値違反検出＋注入ストアへのラン永続化
- **regression** — 2 ラン間のメトリクス差分・リグレッション判定（CI ゲート向け）

## API 例

```ts
import {
  runGoldenCases,
  runEval,
  compareRuns,
  EXAMPLE_GOLDEN_CASES,
  type GoldenCase,
} from "@torihanaku/eval-harness";

// 1) ゴールデンケースをジャッジで評価
const cases: GoldenCase<string>[] = [
  { id: "flag-guarantee", input: "絶対に儲かります", expected: true },
  { id: "pass-plain", input: "進捗を一覧で確認できます", expected: false },
];
const judge = async (input: string) => {
  const verdict = await myLlmModerationCall(input); // LLM ジャッジは注入
  return verdict.flagged;
};
const run = await runGoldenCases(cases, judge);
// run.metrics.f1, run.failures → [{ id, expected, predicted, error? }]

// 2) しきい値チェック＋ラン保存（ストアは注入・省略可）
const result = await runEval(
  { groundTruth: run.pairs, notes: "nightly" },
  { saveRun: async (record) => db.insert("eval_runs", record) },
);
// result.violations → [{ metric: "f1", value, threshold, direction }]

// 3) リグレッション比較（前回ラン vs 今回ラン）
const cmp = compareRuns(baselineMetrics, run.metrics, { tolerance: 0.01 });
if (!cmp.passed) throw new Error(`regression: ${JSON.stringify(cmp.regressions)}`);
```

デフォルトしきい値（出典どおり）: `minF1: 0.7 / minRepeatCatchRate: 0.5 / maxOverrideRetentionRate: 0.4 / similarityThreshold: 0.85`。

## 注入ポイント

| 境界 | インターフェース | 備考 |
|------|-----------------|------|
| ジャッジ（LLM 等） | `JudgeFn<I> = (input, case) => boolean \| Promise<boolean>` | throw したケースは errored（predicted=false）として失敗一覧に載る |
| ラン永続化 | `EvalRunStore { saveRun(record) => Promise<string \| null> }` | 省略可・失敗しても評価結果は返る（best-effort） |
| しきい値 | `thresholds?: Partial<ThresholdConfig>` | 部分上書き可 |
| 埋め込み | `SubmissionForRepeatCatch.embedding` 等 | ベクトルは呼び出し側で生成して渡す（embedding クライアント非依存） |

`EXAMPLE_GOLDEN_CASES` は出典のブランドファイアウォール用途をコンテンツモデレーション例に改名したサンプルフィクスチャ 10 件です（実運用では自ドメインのゴールデンセットに差し替え）。

## Runtime

ランタイム非依存（純 TypeScript、Node / Bun / edge / ブラウザ可）。I/O ゼロ、依存ゼロ。

## 出典

- dev-dashboard-v2 `server/lib/eval/firewall-metrics.ts`（#1040・逐語移植。firewall 固有だった `lint_` プレフィックスのみ一般名に変更: lint_f1 → f1）
- dev-dashboard-v2 `server/lib/eval/firewall-eval-runner.ts`（しきい値検出・ラン永続化の骨格。Supabase → 注入ストア）
- dev-dashboard-v2 `tools/eval-lab/`（Python 製の実験ラボ。「ゴールデンクエリ集合＋ジャッジ＋実験間比較」という設計思想のみ採用。auto-tune / gap-detector はドメイン固有のため対象外）
- テストは `server/__tests__/firewall-metrics.test.ts` を逐語移植＋runner/golden/regression の新規テスト
