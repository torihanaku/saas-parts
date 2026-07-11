/**
 * @torihanaku/press-media — プレスリリース生成・記者CRM・PRオペレーション
 *
 * 3 モジュール:
 * - press-release-engine: プレスリリース生成（4類型 + other）／ブランドチェック／テキスト整形
 * - media-ledger-service: 記者CRM（関係スコア／AIピッチ生成／仕分けルール提案）
 * - pr-ops-service: 配信タイミング提案／PR戦略サマリ生成
 *
 * LLM 呼び出し（generateJson / generateText）は全て注入式。ストア注入は
 * 呼び出し側に委ねる（本パッケージは永続化を持たない）。
 */

export type { GenerateJson, GenerateText, LlmCallOptions } from "./llm";

export {
  generatePressRelease,
  brandCheckPressRelease,
  formatPressReleaseAsText,
} from "./press-release-engine";
export type {
  PressReleaseStructure,
  PRType,
  BrandCheckResult,
} from "./press-release-engine";

export {
  calculateRelationshipScore,
  generatePitchEmail,
  suggestSortRule,
} from "./media-ledger-service";
export type {
  MediaContact,
  MediaInteraction,
  RelationshipScoreBreakdown,
} from "./media-ledger-service";

export { suggestTiming, generateStrategySummary } from "./pr-ops-service";
export type {
  PREvent,
  IndustryEvent,
  TimingSuggestion,
  StrategySummary,
} from "./pr-ops-service";
