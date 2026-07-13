/**
 * @torihanaku/content-generation
 *
 * ペルソナ別コンテンツ生成・コピー多変量生成・長文→SNS原子化・実績ベースリミックス。
 * 実運用SaaS の content-engine / prototype / content routes から抽出。
 * 全 LLM 呼び出しは注入（`GenerateText` / `GenerateJson`）、プロンプトは原文をデフォルト保持。
 *
 * マーケ / ブランド製品向け。ブランド表現の lint は @torihanaku/brand-lint を、
 * Safe/Edgy 2 案の挑戦的コピー生成は @torihanaku/challenger-copy を参照。
 */

export type {
  GenerateText,
  GenerateJson,
  IntelligenceItem,
  KnowledgeItem,
  CrmContact,
} from "./types.js";

export {
  CONTENT_TEMPLATES,
  TONE_GUIDE,
  templateToContentType,
  computeSeoScore,
  generateContent,
  generateReport,
  transformContent,
  extractActionItems,
  type ContentGenerateOptions,
  type GeneratedContent,
  type ReportGenerateOptions,
  type TransformOptions,
} from "./content-engine.js";

export {
  buildCompositeContext,
  formatIntelligenceContext,
  formatKnowledgeContext,
  formatCrmContext,
  type CompositeContextOptions,
} from "./context.js";

export {
  generateCopyVariants,
  COPY_VARIANT_LIMITS,
  type CopyVariant,
  type CopyVariantInput,
  type CopyVariantOutput,
} from "./copy-variants.js";

export {
  ALL_REMIX_FORMATS,
  FORMAT_PROMPTS,
  FORMAT_TYPE_MAP,
  isRemixFormat,
  remixToFormat,
  atomizeContent,
  type RemixFormat,
  type AtomizeSource,
  type AtomizeResult,
} from "./remix.js";

export {
  LP_MOCK_SYSTEM_PROMPT,
  LP_MOCK_FALLBACK_HTML,
  buildLpUserPrompt,
  sanitizeLpHtml,
  generateLpMock,
  type LpMockResult,
} from "./lp-mock.js";

export {
  seededRng,
  synthesizeMetric,
  buildPerformanceReport,
  type ContentDraftLike,
  type ContentPerformanceMetric,
  type PerformanceReport,
} from "./performance.js";
