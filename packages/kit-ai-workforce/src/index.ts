/**
 * @torihanaku/kit-ai-workforce
 *
 * 「AI社員」システム — 役割・性格・スキルを持つ AI キャラクターをチームとして
 * 編成・稼働させるための自己完結キット。状態機械 / SSE / BM25 マッチング /
 * キャラクター CRUD / ロールモデル / テンプレート / チームコンポーザー を、
 * DB・HTTP・LLM に非依存で提供する（すべて注入）。
 *
 * 出典: 実運用SaaS（詳細は README / 各ファイル冒頭）
 */

// 型・注入ポイント
export * from "./types";

// 状態機械 + SSE ブロードキャスト + セッション追跡
export * from "./state";

// BM25 スコアリング（プライベートコピー）
export * from "./bm25";

// タスク→AI社員マッチング
export * from "./matching";

// キャラクター CRUD + Character Studio
export * from "./characters";

// ロールモデル + チームコンポーザー
export * from "./role-models";

// タスク割り当て + 完了評価 → CV 記録 → スキル自動昇格（成長ループ）
export * from "./tasks";

// テンプレート（一覧 / クローン）
export * from "./templates";

// プリセット（オリジナル IP 温存 + 汎用サンプル）
export * from "./presets";

// メモリ内ストア（テスト・クイックスタート用）
export * from "./stores";

// クライアント（React・peer）
export * from "./client/useLiveState";
export * from "./client/useTeamState";
