/**
 * @torihanaku/kit-research-navigator
 *
 * 調査アシスタント: 外部シグナル取り込み → 重要度判定 (verdict) →
 * クラスタ検出 → 仮説カード生成 → アクション実行 → 学び記録。
 *
 * 出典: 実運用SaaS navigator (server/lib/navigator, server/routes/navigator,
 * server/jobs/nav-*)。LLM / 埋め込み / ソース / 課題トラッカー / 永続化は全て注入制。
 */

// Domain types
export * from "./types";

// Injection ports
export * from "./ports";

// In-memory stores (テスト・プロトタイピング用)
export {
  MemorySignalStore,
  MemoryContextStore,
  MemoryCardStore,
  MemoryActionStore,
  MemoryLearningStore,
  MemoryStackStore,
  cosineSimilarity,
} from "./memory-stores";

// Zod schemas
export {
  UseCaseCardSchema,
  HypothesisDraftSchema,
  ContextVerdictLlmSchema,
} from "./schemas";

// Signal sources
export {
  fetchAllSignals,
  createHackerNewsSource,
  createExaSearchSource,
  createPerplexityNewsSource,
} from "./sources/index";
export type {
  FetchAllOptions,
  HackerNewsSourceOptions,
  ExaSearchSourceOptions,
  PerplexityNewsSourceOptions,
} from "./sources/index";
export { extractJsonArray } from "./sources/perplexity";

// Verdict engine
export { judgeVerdict } from "./verdict-engine";
export type { VerdictEngineDeps } from "./verdict-engine";

// Ingest pipeline (定期ジョブの中身)
export { ingestSignals } from "./ingest-pipeline";
export type { IngestDeps, IngestResult } from "./ingest-pipeline";

// Weekly reevaluation (トレンド昇格 + ノイズ削除)
export { reevaluateSignals, pickRepresentative } from "./reevaluate";
export type {
  ReevaluateDeps,
  ReevaluateOptions,
  ReevaluateResult,
} from "./reevaluate";

// Hypothesis drafting
export {
  draftHypothesis,
  buildWarningToHypothesisPrompt,
  HypothesisDraftError,
} from "./hypothesis-drafter";

// Card generation
export { generateManualCard, buildStackAdvisorCard } from "./card-generator";
export type {
  GenerateCardOptions,
  StackAdvisorCardInput,
} from "./card-generator";

// Card lifecycle service
export {
  createManualCard,
  createStackCard,
  listCards,
  getCardDetail,
  updateCardStatus,
  addLearning,
  executeCardAction,
  VALID_TRANSITIONS,
  LEARNING_MIN_LENGTH,
  LEARNING_MAX_LENGTH,
} from "./card-service";
export type {
  CardServiceDeps,
  CardServiceError,
  ServiceResult,
} from "./card-service";

// Action helpers
export { generateSocialDraft } from "./action-executor";

// Weekly brief
export { buildWeeklyBrief } from "./brief-service";
export type { BriefDeps, BriefOptions } from "./brief-service";

// Signal detail
export { fetchSignalDetail } from "./signal-detail";
export type { SignalDetailPayload } from "./signal-detail";

// Issue matching (課題トラッカー突合)
export { suggestRelatedIssues, linkIssueToCard } from "./issue-matcher";
export type { IssueMatchOptions, IssueMatchResult } from "./issue-matcher";

// Stack advisor (RAG)
export { generateStackRecommendation } from "./stack-advisor";
export type { StackAdvisorInput, StackAdvisorDeps } from "./stack-advisor";
