/**
 * types.ts — 組織パターン DNA キットの共有型 + 注入インターフェース。
 *
 * 出典: dev-dashboard-v2 `shared/types/company-dna.ts`（型）、
 * `server/lib/claude-api-client.ts` / `server/lib/embedding-client.ts`
 * （呼び出しシグネチャのインターフェース化。実装は持たない）。
 *
 * 「良い例 / 悪い例を取り込む → 組織のパターンを学習する → 新しいコンテンツを
 * 照合する → 反応を予測する → パターン一致で警告する」という汎用メカニズム。
 */

// ─── 5 つの DNA カテゴリ（DB の CHECK 制約と一致 — README の SQL スキーマ参照） ──
//
// 値は本家 DB スキーマとの互換のためそのまま維持する:
//   content           — 過去コンテンツの成功 / 失敗パターン
//   brand_voice       — 組織の声（文体・トーン規範）
//   customer_reaction — 相手（顧客・読者）の反応パターン
//   seasonal          — 季節性・時系列の傾向
//   glossary          — 組織固有の用語辞書
export const PATTERN_DNA_TYPES = [
  "content",
  "brand_voice",
  "customer_reaction",
  "seasonal",
  "glossary",
] as const;

export type PatternDnaType = (typeof PATTERN_DNA_TYPES)[number];

/** 型ガード — 文字列が既知の dna_type かを検証する。 */
export function isPatternDnaType(v: unknown): v is PatternDnaType {
  return typeof v === "string" && (PATTERN_DNA_TYPES as readonly string[]).includes(v);
}

// ─── 永続化される行（(tenant, dnaType, key) が複合主キー） ─────────────────

/**
 * 蓄積された組織パターン DNA の 1 片。同一テナント・同一 dnaType の同一 key は
 * upsert され、重複しない。
 */
export interface PatternDnaRow {
  tenantId: string;
  dnaType: PatternDnaType;
  /** (tenant, dnaType) 内で安定な識別子。例: slug / snapshot id / 用語。 */
  key: string;
  /** 自由形式の構造化ペイロード。スキーマは dnaType ごとに異なる。 */
  value: Record<string, unknown>;
  /** 出所ラベル。例: "manual" / "scrape:blog" / "approval:approved"。 */
  source: string;
  /** 0.0（不確か）〜 1.0（確定）。手動取り込みのデフォルトは 1.0。 */
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Ingest / List / Stats の契約型 ─────────────────────────────────────────

export interface IngestDnaRequest {
  dna_type: PatternDnaType;
  key: string;
  value: Record<string, unknown>;
  source: string;
  /** 省略時は 1.0。[0, 1] にクランプされる。 */
  confidence?: number;
}

export interface DnaListResponse {
  rows: PatternDnaRow[];
  /** ページング前のフィルタ一致総数。 */
  total: number;
  limit: number;
  offset: number;
}

export interface DnaStats {
  total: number;
  /** dnaType ごとの行数。カウント 0 でも 5 タイプ全て現れる。 */
  byType: Record<PatternDnaType, number>;
  /** 全行の平均 confidence（total = 0 のとき 0）。 */
  meanConfidence: number;
}

export const PATTERN_DNA_ERRORS = {
  INVALID_DNA_TYPE: "invalid_dna_type",
  KEY_REQUIRED: "key_required",
  VALUE_REQUIRED: "value_required",
  SOURCE_REQUIRED: "source_required",
  CONFIDENCE_OUT_OF_RANGE: "confidence_out_of_range",
  TENANT_REQUIRED: "tenant_id_required",
  UPSERT_FAILED: "upsert_failed",
  LIST_FAILED: "list_failed",
} as const;

export type PatternDnaErrorCode =
  (typeof PATTERN_DNA_ERRORS)[keyof typeof PATTERN_DNA_ERRORS];

// ─── LLM 注入インターフェース ───────────────────────────────────────────────

/**
 * 構造化出力の LLM 呼び出し。キットはプロバイダと直接通信しない。
 * `@torihanaku/claude-api` の generateJson を薄くラップすればそのまま満たせる
 * （API キーは実装側でバインドする）。パース失敗時は `fallback` を返すこと。
 */
export interface LlmCaller {
  generateJson<T>(
    system: string,
    prompt: string,
    fallback: T,
    opts?: { maxTokens?: number; model?: string },
  ): Promise<T>;
}

// ─── Embedding 注入インターフェース ─────────────────────────────────────────

export interface EmbeddingNeighbor {
  id: string;
  /** コサイン類似度など [0, 1]。 */
  similarity: number;
  /** status="rejected" 検索時のみ意味を持つ（却下理由）。 */
  rejectionReason?: string | null;
}

/**
 * 類似スナップショット検索。本家は pgvector RPC
 * （match_brand_dna_by_embedding / match_brand_dna_rejected）だったものを
 * インターフェース化。`@torihanaku/embeddings` の検索がこれを満たす。
 */
export interface EmbeddingSearcher {
  search(
    text: string,
    opts: {
      tenantId: string;
      topK: number;
      threshold: number;
      /** 承認済みコーパス or 却下コーパスのどちらを検索するか。 */
      status: "approved" | "rejected";
    },
  ): Promise<EmbeddingNeighbor[]>;
}

/** テキスト → ベクトル。スナップショット取り込みで使用。 */
export type EmbeddingGenerator = (text: string) => Promise<number[]>;
