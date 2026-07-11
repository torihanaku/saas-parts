/**
 * @torihanaku/brand-lint
 *
 * 表現lint（禁止語 / トーン / 類似度）＋ 却下事例からのルール自動進化。
 * dev-dashboard-v2 の Brand Firewall ルールエンジン側（word/tone/similarity checkers、
 * hard negative の embedding 注入、ルール進化の LLM 注入）から抽出。
 *
 * マーケ / ブランド製品向け。承認ワークフロー本体（申請〜承認〜監査）は
 * @torihanaku/kit-approval-workflow を参照。
 */

export type {
  BrandViolation,
  BrandVoiceRules,
  BrandDnaSnapshot,
  SimilarityMatch,
  QuickFixResult,
  GenerateJson,
  EmbedText,
  EmbedBatch,
} from "./types.js";

export { matchForbiddenWords } from "./forbiddenWordMatcher.js";

export {
  checkTone,
  type ToneCheckOutput,
  type ToneCheckDeps,
} from "./toneChecker.js";

export { checkSimilarity, SIMILARITY_THRESHOLD } from "./similarityCheck.js";

export { generateQuickFix, type QuickFixDeps } from "./quickFixGenerator.js";

export { ingestRecentRejections, type IngestDeps } from "./hardNegativesEmbedder.js";

export {
  runRuleEvolution,
  type RuleEvolutionDeps,
} from "./lintRuleEvolution.js";

export {
  DECAY_HALF_LIFE_DAYS,
  HARD_CUTOFF_DAYS,
  DEFAULT_RELEVANCE_THRESHOLD,
  decayWeight,
  isStillRelevant,
  daysSince,
  weightSamples,
  selectRelevantSamples,
  weightedCount,
  type HardNegativeSample,
  type WeightedSample,
} from "./hardNegativeDecay.js";

export {
  InMemoryBrandLintStore,
  type BrandLintStore,
  type RejectedSubmission,
  type DnaSnapshotRow,
  type HardNegativeInsert,
  type RuleProposalInsert,
} from "./stores.js";
