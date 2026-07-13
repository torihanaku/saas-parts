/**
 * @torihanaku/kit-pattern-dna
 *
 * 組織パターン DNA キット — 良い例 / 悪い例を取り込み、組織のパターン
 * （文体・成功要因・相手の反応）を学習し、新しいコンテンツを照合して
 * 反応予測・パターン警告を返す。出典: 実運用SaaS（詳細は README）。
 */

// 型 + 注入インターフェース
export * from "./types.js";
// ストア（注入インターフェース + インメモリ実装）
export * from "./stores.js";
// 蓄積基盤（validate / ingest / list / stats）
export * from "./foundation.js";
// 組織ボイスプロファイル学習
export * from "./voice-profile.js";
// 過去コンテンツの成功 / 失敗パターン取り込み
export * from "./content-ingest.js";
// 相手の反応マトリクス + ベストメッセージ推薦
export * from "./customer-reaction.js";
// 下書き照合アラート（Jaccard・API 依存なし）
export * from "./pattern-alerts.js";
// 回帰ベースの反応予測 + チャネル推薦
export * from "./predict.js";
// embedding 類似検索ベースの予測・推薦・スナップショット蓄積
export * from "./similarity-predict.js";

// React クライアントフック（react が必要 — peerDependency / optional）
export {
  createPatternDnaHooks,
  DEFAULT_PATTERN_DNA_ENDPOINTS,
} from "./client/hooks.js";
export type {
  PatternDnaClientApi,
  PatternDnaEndpoints,
  CheckPatternAlertsClientArgs,
  UsePatternAlertsReturn,
  UseAutoPatternAlertsArgs,
  UseAutoPatternAlertsReturn,
} from "./client/hooks.js";
