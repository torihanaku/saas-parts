// @ts-check
/**
 * Stryker ミューテーションテスト設定。
 *
 * 目的: 「テストは通っているが、実はバグを検知できていない」を数値で暴く。
 * コードに意図的な変異（>= を > に、&& を || に、return true など）を注入し、
 * テストがそれを "殺せる"（fail する）かを測る。生き残った変異 = テストの穴。
 * 今回の全数監査で見つかった 43 件の多くは、まさにこの穴に潜んでいた。
 *
 * 既定は "見えない20%" の中核パッケージのみを対象にした軽量パイロット。
 * 対象を広げるには MUTATE 環境変数を渡す:
 *   MUTATE='packages/audit-log/src/**\/*.ts' bun run mutation
 */
const DEFAULT_MUTATE = [
  "packages/security-utils/src/**/*.ts",
  "packages/audit-log/src/**/*.ts",
  "packages/stripe-billing/src/**/*.ts",
  "packages/cache/src/**/*.ts",
  "!packages/**/*.test.ts",
  "!packages/**/*.property.test.ts",
];

const mutate = process.env.MUTATE ? [process.env.MUTATE, "!packages/**/*.test.ts"] : DEFAULT_MUTATE;

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // bun のインストール構造(node_modules/.bun/...)だとプラグイン自動探索が外すので明示。
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.config.ts" },
  // このリポは typescript@7 (ネイティブ版) を使っており、Stryker が依存する旧
  // コンパイラ API (ts.parseConfigFileTextToJson) が無い。tsconfig 前処理段だけを
  // 回避するため、存在しないパスを指して当該プリプロセッサをスキップさせる
  // （変異注入・テスト実行には影響しない）。TS7 native 対応が入ったら削除可。
  tsconfigFile: "stryker-no-tsconfig.json",
  coverageAnalysis: "perTest",
  mutate,
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  // 変異検知率のガード。閾値未満なら break（CI ゲート化する場合に使う）。
  // 初期は可視化目的で break: null（落とさない）。棚卸し後に 60 などへ。
  thresholds: { high: 80, low: 60, break: null },
  ignoreStatic: true,
  concurrency: 4,
  timeoutMS: 20000,
};
