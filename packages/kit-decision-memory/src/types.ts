/**
 * kit-decision-memory — 型定義と注入ポイント。
 *
 * 出典: 実運用SaaS shared/types/institutional-memory.ts ほか。
 * 製品固有の decision カテゴリ / mem_type はデフォルト値としてのみ保持し、
 * 各サービスのコンストラクタでパラメータ化できる。
 */

// ── デフォルト分類（パラメータ化可能） ──────────────────────────────────────
export const DEFAULT_MEM_TYPES = [
  "decision_log",
  "failure_recipe",
  "success_recipe",
] as const;

export const DEFAULT_DECISION_TYPES = [
  "start",
  "stop",
  "change",
  "pivot",
  "archive",
] as const;

// ── ナレッジ（組織記憶）アイテム ────────────────────────────────────────────
export interface MemoryItem {
  id: string;
  tenantId: string;
  memType: string;
  subject: string;
  content: string;
  source: string | null;
  decidedBy: string | null;
  /** ISO-8601 */
  decidedAt: string;
  /** ISO-8601 */
  createdAt: string;
  /** 検索結果にのみ付与される 0–1 のスコア。 */
  similarity?: number;
}

export interface LogMemoryInput {
  memType: string;
  subject: string;
  content: string;
  source?: string | null;
  decidedBy?: string | null;
  /** ISO-8601。省略時はサービス側の now()。 */
  decidedAt?: string | null;
}

export interface SearchMemoryOptions {
  /** デフォルト 5、上限 20。 */
  topK?: number;
  memType?: string;
  /** 類似度の下限（EmbeddingSearcher 使用時のみ有効）。デフォルト 0.6。 */
  threshold?: number;
}

export interface SearchMemoryResult {
  results: MemoryItem[];
  /** LLM 要約。TextGenerator 未注入・結果 0 件・生成失敗時は ""。 */
  summary: string;
}

// ── 意思決定レコード ────────────────────────────────────────────────────────
export interface DecisionRecord {
  id: string;
  tenantId: string;
  decisionType: string;
  subject: string;
  context: string;
  /** なぜそうしたか（Why）。 */
  reason: string;
  alternativesConsidered: string | null;
  decidedBy: string | null;
  decidedAt: string;
  /** 'manual' | 'chat' | 'email' | 'meeting' など。自由文字列。 */
  source: string;
  /** 外部システムへの参照（permalink 等）。 */
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface CreateDecisionInput {
  decisionType: string;
  subject: string;
  reason: string;
  context?: string | null;
  alternativesConsidered?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  source?: string;
  sourceRef?: string | null;
}

export interface UpdateDecisionInput {
  decisionType?: string;
  subject?: string;
  context?: string | null;
  reason?: string;
  alternativesConsidered?: string | null;
  decidedAt?: string;
}

// ── 抽出候補（ステージング → confirm で本ログにリンク） ─────────────────────
export type PendingDecisionStatus = "pending" | "confirmed" | "rejected";

export interface PendingDecision {
  id: string;
  tenantId: string;
  /** 抽出元への参照（チャットの permalink 等）。 */
  sourceRef: string;
  /** 抽出元チャネル名（任意）。 */
  channel: string | null;
  rawText: string;
  extractedSubject: string | null;
  extractedReason: string | null;
  extractedType: string | null;
  /** 0.00–1.00 */
  confidence: number | null;
  status: PendingDecisionStatus;
  confirmedDecisionId: string | null;
  extractedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface ConfirmPendingOverrides {
  decisionType?: string;
  subject?: string;
  reason?: string;
}

// ── why 検索 ────────────────────────────────────────────────────────────────
export interface WhyCitation {
  decisionId: string;
  decisionType: string;
  subject: string;
  decidedAt: string;
  similarity: number;
}

export interface WhySearchResult {
  answer: string;
  citations: WhyCitation[];
  /** false = 関連記録なし。 */
  hasAnswer: boolean;
}

// ── オンボーディング ────────────────────────────────────────────────────────
export interface OnboardingResult {
  summary: string;
  keyDecisions: Array<{ id: string; subject: string; reason: string }>;
  knownChannels: string[];
  recommendedReading: Array<{ title: string; url?: string }>;
}

// ── 注入ポイント ────────────────────────────────────────────────────────────
/** テキスト → ベクトル。@torihanaku/embeddings のプロバイダで充足できる。 */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/**
 * セマンティック検索の注入点。pgvector RPC・@torihanaku/embeddings +
 * ベクトルストア等で充足する。未注入時は内蔵 BM25 キーワード検索に
 * フォールバックする。
 */
export interface EmbeddingSearcher {
  search(
    query: string,
    opts: { tenantId: string; topK: number; threshold: number; memType?: string },
  ): Promise<Array<{ id: string; similarity: number }>>;
}

/** LLM 呼び出し（要約・回答生成）。未注入なら生成をスキップ。 */
export type TextGenerator = (
  system: string,
  user: string,
  opts?: { maxTokens?: number },
) => Promise<string>;

/** ロガー注入点（デフォルトは no-op）。 */
export interface KitLogger {
  info(scope: string, message: string): void;
  error(scope: string, error: unknown): void;
}

export const NOOP_LOGGER: KitLogger = {
  info: () => undefined,
  error: () => undefined,
};

/** id / 時刻の注入（テストの決定性のため）。 */
export interface ServiceContext {
  now?: () => Date;
  generateId?: () => string;
}

export function resolveContext(ctx: ServiceContext | undefined): {
  now: () => Date;
  generateId: () => string;
} {
  return {
    now: ctx?.now ?? (() => new Date()),
    generateId: ctx?.generateId ?? (() => globalThis.crypto.randomUUID()),
  };
}

// ── エラー ──────────────────────────────────────────────────────────────────
export class DecisionMemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionMemoryValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
