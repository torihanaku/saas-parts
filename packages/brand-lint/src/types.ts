/**
 * 共有型 — 表現lint（禁止語 / トーン / 類似度）とルール自動進化。
 *
 * 実運用SaaS の Brand Firewall（server/services/brandLint + jobs）から抽出。
 * 具体的な永続化（Supabase）や LLM / embedding クライアントはすべて注入 (ports) に置換。
 */

/** ブランド違反の 1 件。 */
export interface BrandViolation {
  type: "forbidden_word" | "tone_mismatch" | "voice_mismatch";
  severity: "error" | "warning" | "info";
  message: string;
  matchedText?: string;
  span?: [number, number];
  suggestion?: string;
}

/** ブランド DNA の voice / tone ルール（自由形の JSON）。 */
export interface BrandVoiceRules {
  description?: string;
  narrativeStyle?: string;
  [key: string]: unknown;
}

/** 最新のブランド DNA スナップショット。 */
export interface BrandDnaSnapshot {
  voice?: BrandVoiceRules | null;
  tone?: BrandVoiceRules | null;
  forbidden_words?: string[] | null;
}

/** 類似度検索でヒットした過去の却下案件。 */
export interface SimilarityMatch {
  id: string;
  similarity: number;
  rejection_reason: string;
}

/** AI クイックフィックスの結果。 */
export interface QuickFixResult {
  before: string;
  after: string;
  rationale: string;
}

/* ── 注入ポート（LLM / embedding） ─────────────────────────────────────── */

/**
 * JSON を返す LLM 呼び出し。実運用SaaS の `generateJson(apiKey, system, user, fallback, opts)`
 * を汎用化。失敗時に fallback を返す実装を想定。
 */
export type GenerateJson = <T>(
  system: string,
  user: string,
  fallback: T,
  options?: { maxTokens?: number },
) => Promise<T>;

/** テキストの embedding（1 件）を返す関数。 */
export type EmbedText = (text: string) => Promise<number[]>;

/** テキストの embedding（バッチ）を返す関数。 */
export type EmbedBatch = (texts: string[]) => Promise<number[][]>;
