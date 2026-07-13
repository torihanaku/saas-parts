/**
 * @torihanaku/challenger-copy
 *
 * Safe / Edgy 2 案コピー生成 → 提示 → 選択フィードバック学習ループ。
 * 実運用SaaS の Active Learning「Challenger」機構から抽出。
 *
 * マーケ / ブランド製品向け。lint 連携は import せず注入述語（`LintCheck`）で受ける
 * （@torihanaku/brand-lint / @torihanaku/kit-approval-workflow が充足）。
 * LLM / embedding / 永続化はすべて注入。
 */

export type {
  ChallengerInput,
  ChallengerProposal,
  DualOptionsResult,
  BrandDnaContext,
  GenerateJson,
  EmbedText,
  LintCheck,
  LintOutcome,
} from "./types.js";

export {
  generateChallengerProposals,
  type ChallengerGeneratorDeps,
} from "./challenger-generator.js";

export { generateDualOptions, type DualOptionsDeps } from "./dualOptions.js";

export {
  recordHardNegative,
  checkHardNegativeSimilarity,
  HARD_NEGATIVE_SIMILARITY_THRESHOLD,
  type RecordHardNegativeInput,
  type HardNegativeRecord,
  type FeedbackLoopDeps,
  type CheckSimilarityDeps,
  type HardNegativeMatch,
  type HardNegativeSimilarityResult,
} from "./feedback-loop.js";

export {
  runChallengerLint,
  type ChallengerLintInput,
  type ChallengerLintResult,
  type LintIntegrationDeps,
} from "./lint-integration.js";

export {
  aggregateDailyMetrics,
  getChallengerMetrics,
  type DailyMetrics,
  type MetricsSummary,
} from "./metrics-aggregator.js";

export {
  InMemoryChallengerStore,
  type ChallengerStore,
  type ChallengerProposalRow,
  type SavedChallengerProposalRow,
  type HardNegativeInsert,
  type HardNegativeMatchRow,
  type DailyMetricsRow,
} from "./stores.js";
