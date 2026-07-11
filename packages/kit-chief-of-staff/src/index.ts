/**
 * @torihanaku/kit-chief-of-staff — AI 経営アシスタント（Chief of Staff）キット。
 *
 * ingest（Slack/Email/Meeting）→ digest feed → briefing → Q&A →
 * タスク抽出/レビュー/外部同期 のパイプライン。
 * 依存（LLM / 同意 / ストレージ / 外部コネクタ）はすべて注入式。
 */

// 型・注入インターフェース
export * from "./types";

// ストア（インターフェース + インメモリ実装）
export * from "./stores";

// ingest
export * from "./slack-ingest";
export * from "./email-ingest";
export * from "./meeting-ingest";

// briefing / Q&A
export * from "./briefing-generator";
export * from "./qa-engine";

// タスク同期・レビュー
export * from "./linear-client";
export * from "./task-sync";
export * from "./task-review";

// feed / settings
export * from "./feed";
export * from "./settings";

// React hooks（利用には react が必要 — peerDependency）
export * from "./client/hooks";
