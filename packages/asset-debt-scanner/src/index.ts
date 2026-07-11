/**
 * @torihanaku/asset-debt-scanner — 資産劣化の巡回スキャン + 修繕提案フレームワーク
 *
 * dev-dashboard-v2 の Marketing Debt Tracker (#355) から抽出。
 * 「放置すると価値が下がる資産」を per-tenant で巡回スキャンし、劣化スコアと
 * 修繕提案を出す。
 *
 * コア 3 部品:
 * - scorer  … freshness decay + メタデータで severity / recommendation を算出。
 * - scanner … `AssetScanner` レジストリ + 並列オーケストレータ (per-scanner error isolation)。
 * - suggester … 負債 1 件 → 3 案の修正提案 (LLM 注入)。
 *
 * scanner 群 (dead-link / image / seo-quality / seo-rank / dormant-email /
 * crm-bounce / schedule-expiry) は `AssetScanner` の実装例として全種同梱。
 * 外部 API (HTTP プローブ) は fetch 注入、永続化は DebtStore 注入。
 *
 * ドメイン用語 (marketing debt / 6 asset 種別) はマーケ由来。config で差し替え可能。
 */

export type {
  AssetType,
  DebtSeverity,
  DebtScoringInput,
  DebtScoringResult,
  DebtRecord,
  DebtStore,
  ScanContext,
  ScanSummaryBase,
} from "./types";
export { DEFAULT_ASSET_TYPES } from "./types";

export {
  DEFAULT_DECAY_RATES,
  isKnownAssetType,
  deriveSeverity,
  daysSince,
  computeFreshness,
  scoreContent,
  scorePersona,
  scoreCampaign,
  scoreLink,
  scoreSeoArticle,
  scoreCrmData,
  scoreDebtItem,
} from "./scorer";

export {
  type AssetScanner,
  type ScannerStatus,
  type OrchestratorInputs,
  type OrchestratorResult,
  ScannerRegistry,
  persist,
  makeRecord,
} from "./scanner";

export {
  type DebtSuggestion,
  type DebtSuggestionRequest,
  type GenerateJson,
  FALLBACK_SUGGESTIONS,
  generateDebtSuggestions,
} from "./suggester";

export * from "./scanners/index";
