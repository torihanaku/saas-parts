export {
  registerProvider,
  clearProviders,
  listProviders,
  getProvider,
  embedText,
  embedBatch,
  setPrimaryProvider,
  setEmbedGuard,
  type EmbedGuard,
  type EmbedGuardContext,
  type EmbedOptions,
} from "./registry";

export { EmbeddingProviderError, type EmbeddingProvider } from "./types";

export { createOpenAIProvider } from "./providers/openai";

export {
  createCostPipeline,
  estimateTokens,
  estimateCostJpy,
  currentYearMonth,
  EmbeddingBudgetExceededError,
  DEFAULT_MONTHLY_LIMIT_JPY,
  type EmbeddingCostStore,
  type MonthlyCostRow,
  type CostPipelineConfig,
  type PipelineOptions,
  type EmbeddingCostPipeline,
  type EmbeddingPipelineResult,
} from "./cost-pipeline";
