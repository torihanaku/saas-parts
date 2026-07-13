/**
 * content-ingest.ts — 過去コンテンツの成功 / 失敗パターン取り込み。
 *
 * 過去記事のメタデータ（PV / CV / 修正履歴）と LLM による成功 / 失敗パターン
 * 分類を DNA ストア（dnaType=content）へ upsert する。LLM 失敗時は fallback を
 * 返して永続化は継続する（パターン DNA は補助情報なので LLM 故障で取り込み
 * 自体を失敗させない）。
 *
 * 出典: 実運用SaaS `server/lib/company-dna/content-ingest.ts`
 * （Claude API 直呼び → LlmCaller 注入、Supabase → DnaStore 注入、
 * tier しきい値 → 設定化）。
 */

import type { LlmCaller, PatternDnaRow } from "./types.js";
import type { DnaStore } from "./stores.js";
import { ingestDna } from "./foundation.js";

// ─── Public input contract ──────────────────────────────────────────────────

/** 過去のコンテンツ 1 本分の入力メタデータ。 */
export interface ContentArticleInput {
  /** 一意な識別子。`key` に `dna-content:<id>` として埋め込まれる。 */
  article_id: string;
  title?: string;
  /** 本文または要約（LLM 分類入力）。 */
  body?: string;
  /** PV >= 0。未指定は 0。 */
  pv?: number;
  /** CV >= 0。未指定は 0。 */
  cv?: number;
  published_at?: string;
  /** レビュー修正履歴（1 エントリ = 1 ラウンド）。 */
  revisions?: ContentRevision[];
  tags?: string[];
  /** 取り込み元（`manual` / `scrape:wp` / `csv-upload` など）。 */
  source: string;
}

export interface ContentRevision {
  before?: string;
  after?: string;
  /** レビュアーのコメント / 指示文。 */
  comment?: string;
}

// ─── Validation primitives ──────────────────────────────────────────────────

export type ContentValidationError =
  | "article_id_required"
  | "source_required"
  | "pv_invalid"
  | "cv_invalid"
  | "revisions_invalid"
  | "tags_invalid";

export interface ValidatedContentIngest {
  articleId: string;
  title: string;
  body: string;
  pv: number;
  cv: number;
  publishedAt: string | null;
  revisions: ContentRevision[];
  tags: string[];
  source: string;
}

/**
 * ContentArticleInput を検証する。成功時は正規化済みの値、失敗時は呼び出し層が
 * 400 として返せる具体的なエラーコードを返す。
 */
export function validateContentIngestRequest(
  input: Partial<ContentArticleInput>,
): { ok: true; value: ValidatedContentIngest } | { ok: false; error: ContentValidationError } {
  if (typeof input.article_id !== "string" || input.article_id.trim().length === 0) {
    return { ok: false, error: "article_id_required" };
  }
  if (typeof input.source !== "string" || input.source.trim().length === 0) {
    return { ok: false, error: "source_required" };
  }
  const pv = normaliseNonNegative(input.pv);
  if (pv === null) return { ok: false, error: "pv_invalid" };
  const cv = normaliseNonNegative(input.cv);
  if (cv === null) return { ok: false, error: "cv_invalid" };

  if (input.revisions !== undefined && !Array.isArray(input.revisions)) {
    return { ok: false, error: "revisions_invalid" };
  }
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    return { ok: false, error: "tags_invalid" };
  }

  return {
    ok: true,
    value: {
      articleId: input.article_id.trim(),
      title: typeof input.title === "string" ? input.title : "",
      body: typeof input.body === "string" ? input.body : "",
      pv,
      cv,
      publishedAt:
        typeof input.published_at === "string" && input.published_at ? input.published_at : null,
      revisions: Array.isArray(input.revisions) ? input.revisions.filter(isRevision) : [],
      tags: Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === "string") : [],
      source: input.source.trim(),
    },
  };
}

function normaliseNonNegative(v: unknown): number | null {
  if (v === undefined || v === null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function isRevision(v: unknown): v is ContentRevision {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    (r.before === undefined || typeof r.before === "string") &&
    (r.after === undefined || typeof r.after === "string") &&
    (r.comment === undefined || typeof r.comment === "string")
  );
}

// ─── パフォーマンス tier 判定（ルールベース、LLM 不要） ─────────────────────

export type PerformanceTier = "success" | "neutral" | "failure";

/** tier 判定のしきい値（マーケ固有の既定値を設定として注入可能に）。 */
export interface TierThresholds {
  /** これ未満の PV はサンプル不足として "neutral"。デフォルト 50。 */
  minPv: number;
  /** CVR がこれ以上なら "success"。デフォルト 0.03。 */
  successCvr: number;
  /** CVR がこれ未満なら "failure"。デフォルト 0.005。 */
  failureCvr: number;
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  minPv: 50,
  successCvr: 0.03,
  failureCvr: 0.005,
};

/**
 * 純粋ヒューリスティック: CVR (cv/pv) と pv 量の組合せで tier を返す。
 * LLM 分類は別軸（パターン抽出）を担当する。tier は再現可能な数値判定。
 */
export function derivePerformanceTier(
  pv: number,
  cv: number,
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
): PerformanceTier {
  if (pv < thresholds.minPv) return "neutral";
  const cvr = cv / pv;
  if (cvr >= thresholds.successCvr) return "success";
  if (cvr < thresholds.failureCvr) return "failure";
  return "neutral";
}

/** revisions の要約数値（LLM プロンプトと DB value の双方で使う）。 */
export function summariseRevisions(revs: ContentRevision[]): {
  count: number;
  totalCommentChars: number;
  totalDiffChars: number;
} {
  let totalCommentChars = 0;
  let totalDiffChars = 0;
  for (const r of revs) {
    if (r.comment) totalCommentChars += r.comment.length;
    if (r.before) totalDiffChars += r.before.length;
    if (r.after) totalDiffChars += r.after.length;
  }
  return { count: revs.length, totalCommentChars, totalDiffChars };
}

// ─── LLM パターン分類 ───────────────────────────────────────────────────────

export interface ContentPatternFeatures {
  /** "success" / "failure" / "neutral"。derivePerformanceTier と独立判定。 */
  tier: PerformanceTier;
  /** 成功要因 / 失敗要因の 1〜5 個の特徴（短い日本語句）。 */
  features: string[];
  /** レビュー修正パターン（短句、0〜5 個。例: "具体例追加", "結論先出し"）。 */
  revision_patterns: string[];
  /** 1 行サマリー（UI 表示用）。 */
  summary: string;
}

const PATTERN_FALLBACK: ContentPatternFeatures = {
  tier: "neutral",
  features: [],
  revision_patterns: [],
  summary: "",
};

/** 本家原文の system プロンプト（デフォルト値として維持）。 */
export const DEFAULT_PATTERN_SYSTEM_PROMPT = [
  "あなたは B2B コンテンツ編集者として、 過去の自社記事の成功 / 失敗パターンを分析する。",
  "JSON のみを返答する。 マークダウンや解説は一切含めない。",
  '形式: {"tier": "success"|"neutral"|"failure", "features": ["..."], "revision_patterns": ["..."], "summary": "..."}',
  "features は 1〜5 個の短い日本語句で、 なぜ成功 / 失敗したかの仮説を返す。",
  "revision_patterns は上司修正の傾向 (短句、 0〜5 個)。 修正履歴が無ければ空配列。",
  "summary は 1 行 50 文字以内の編集者向けメモ。",
].join("\n");

export interface ClassifyContentPatternOptions {
  thresholds?: TierThresholds;
  /** system プロンプトの差し替え（省略時は本家原文）。 */
  systemPrompt?: string;
}

/**
 * LLM にコンテンツを渡し、success/failure パターンを抽出させる。
 *
 * - llm が null なら呼び出さず fallback を返す（永続化は継続できる）。
 * - LLM 実装は失敗時に fallback を返す契約（LlmCaller）なので throw しない。
 */
export async function classifyContentPattern(
  llm: LlmCaller | null,
  v: ValidatedContentIngest,
  opts: ClassifyContentPatternOptions = {},
): Promise<ContentPatternFeatures> {
  const thresholds = opts.thresholds ?? DEFAULT_TIER_THRESHOLDS;
  if (!llm) return { ...PATTERN_FALLBACK, tier: derivePerformanceTier(v.pv, v.cv, thresholds) };

  const summary = summariseRevisions(v.revisions);
  const revisionsLine = summary.count
    ? `修正履歴: ${summary.count} ラウンド / コメント計 ${summary.totalCommentChars} 文字 / diff 計 ${summary.totalDiffChars} 文字`
    : "修正履歴: なし";

  const userPrompt = [
    `記事タイトル: ${v.title || "(タイトルなし)"}`,
    `本文 (抜粋 1500 文字): ${(v.body || "").slice(0, 1500)}`,
    `タグ: ${v.tags.length ? v.tags.join(", ") : "(なし)"}`,
    `PV: ${v.pv}  /  CV: ${v.cv}  /  CVR: ${v.pv > 0 ? ((v.cv / v.pv) * 100).toFixed(2) : "0"}%`,
    revisionsLine,
    "",
    "上記の記事メタを踏まえ、 成功 / 失敗の特徴量と上司修正パターンを JSON で返してください。",
  ].join("\n");

  const result = await llm.generateJson<ContentPatternFeatures>(
    opts.systemPrompt ?? DEFAULT_PATTERN_SYSTEM_PROMPT,
    userPrompt,
    PATTERN_FALLBACK,
    { maxTokens: 1500 },
  );
  return normalisePattern(result, v, thresholds);
}

function normalisePattern(
  raw: ContentPatternFeatures,
  v: ValidatedContentIngest,
  thresholds: TierThresholds,
): ContentPatternFeatures {
  // 防御的: LLM が tier を返さない / 不正値を返した場合はヒューリスティックで補う。
  const tier: PerformanceTier =
    raw.tier === "success" || raw.tier === "failure" || raw.tier === "neutral"
      ? raw.tier
      : derivePerformanceTier(v.pv, v.cv, thresholds);
  return {
    tier,
    features: Array.isArray(raw.features)
      ? raw.features.filter((s) => typeof s === "string").slice(0, 5)
      : [],
    revision_patterns: Array.isArray(raw.revision_patterns)
      ? raw.revision_patterns.filter((s) => typeof s === "string").slice(0, 5)
      : [],
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 200) : "",
  };
}

// ─── トップレベルオーケストレータ: 分類 + upsert ────────────────────────────

export interface IngestContentDnaInput extends ValidatedContentIngest {
  tenantId: string;
}

export interface IngestContentDnaResult {
  row: PatternDnaRow;
  pattern: ContentPatternFeatures;
}

export interface IngestContentDnaDeps {
  store: DnaStore;
  /** null なら LLM 分類をスキップしヒューリスティック tier のみ。 */
  llm?: LlmCaller | null;
  options?: ClassifyContentPatternOptions;
}

/**
 * LLM でコンテンツを分類し、DNA ストア（dnaType=content）へ upsert する。
 *
 * 永続化された行 + 抽出パターンを返す。基盤の ingestDna() が失敗したときは
 * null（呼び出し層が 500 にマップする）。
 */
export async function ingestContentDna(
  deps: IngestContentDnaDeps,
  input: IngestContentDnaInput,
): Promise<IngestContentDnaResult | null> {
  const pattern = await classifyContentPattern(deps.llm ?? null, input, deps.options);
  const tier = pattern.tier;

  // confidence: 特徴量つき success/failure → 0.9、neutral → 0.5。
  const confidence = tier === "neutral" || pattern.features.length === 0 ? 0.5 : 0.9;

  const row = await ingestDna(deps.store, {
    tenantId: input.tenantId,
    dnaType: "content",
    key: `dna-content:${input.articleId}`,
    value: {
      article_id: input.articleId,
      title: input.title,
      pv: input.pv,
      cv: input.cv,
      cvr: input.pv > 0 ? input.cv / input.pv : 0,
      published_at: input.publishedAt,
      tier,
      features: pattern.features,
      revision_patterns: pattern.revision_patterns,
      revisions_summary: summariseRevisions(input.revisions),
      summary: pattern.summary,
      tags: input.tags,
    },
    source: input.source,
    confidence,
  });

  if (!row) return null;
  return { row, pattern };
}
