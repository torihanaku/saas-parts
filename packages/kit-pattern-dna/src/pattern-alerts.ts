/**
 * pattern-alerts.ts — 下書きと過去パターンの照合アラート。
 *
 * 新しいコンテンツを書いている最中に、2 つの相補的なシグナルを提示する:
 *
 *   - failureWarnings — `value.outcome` が "failure" / "rejected" /
 *     "low_engagement" 等だった過去 DNA 行のうち、下書きと強く重なるもの。
 *
 *   - successRecommendations — `value.outcome` が "success" / "approved" /
 *     "high_engagement" 等だった過去 DNA 行のうち、下書きと強く重なるもの。
 *
 * 類似度はローカル計算（Jaccard トークン重なり）— embedding / 外部 API 依存
 * なしで、`value` に text / summary / title を持つ任意の DNA 行に対して動く。
 * より高精度な embedding 経路は similarity-predict.ts が担う（両者は併存可能）。
 *
 * 出典: 実運用SaaS `server/lib/company-dna/pattern-alerts.ts`
 * （Supabase 直結 → DnaStore 注入）。
 */

import type { PatternDnaType } from "./types.js";
import { isPatternDnaType } from "./types.js";
import type { DnaStore } from "./stores.js";

// ─── Outcome 分類 ───────────────────────────────────────────────────────────

/**
 * `value.outcome`（または `value.status` / `value.result`）内で「失敗」
 * パターンとして認識する文字列トークン。異種の DNA 生成元（手動取り込み・
 * 承認却下・低エンゲージメント計測）が同じ警告面に流れ込むよう、
 * 意図的に寛容なリストにしている。
 */
export const FAILURE_OUTCOMES: ReadonlySet<string> = new Set([
  "failure",
  "failed",
  "rejected",
  "denied",
  "low_engagement",
  "underperformed",
  "negative",
]);

export const SUCCESS_OUTCOMES: ReadonlySet<string> = new Set([
  "success",
  "succeeded",
  "approved",
  "high_engagement",
  "outperformed",
  "viral",
  "positive",
]);

export type OutcomeKind = "failure" | "success" | "neutral";

/** DNA 行の `value` ペイロードを調べ、どのアラートバケットに入るか判定する。 */
export function classifyOutcome(value: unknown): OutcomeKind {
  if (!value || typeof value !== "object") return "neutral";
  const v = value as Record<string, unknown>;
  // `outcome` を優先し、`status` / `result` にフォールバック。
  const raw = (v.outcome ?? v.status ?? v.result) as unknown;
  if (typeof raw !== "string") return "neutral";
  const norm = raw.toLowerCase().trim();
  if (FAILURE_OUTCOMES.has(norm)) return "failure";
  if (SUCCESS_OUTCOMES.has(norm)) return "success";
  return "neutral";
}

// ─── トークン化 + Jaccard 類似度（純粋ヘルパ） ──────────────────────────────

const TOKEN_SPLIT = /[\s\p{P}\p{S}]+/u; // 空白 + 句読点 + 記号
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be",
  "of", "to", "in", "on", "for", "with", "as", "at", "by", "from", "this",
  "that", "it", "its", "we", "you", "i", "he", "she", "they",
  // 日本語の頻出助詞（粗い — Jaccard はノイズに寛容なのでこれで十分）
  "の", "は", "が", "を", "に", "で", "と", "も", "や", "から", "まで", "より",
  "です", "ます", "した", "する", "ある", "いる",
]);

/** 小文字化 + 句読点/空白で分割 + ストップワード除去 + 2 文字未満除去。 */
export function tokenize(input: unknown): Set<string> {
  if (typeof input !== "string" || input.length === 0) return new Set();
  const tokens = input.toLowerCase().split(TOKEN_SPLIT);
  const out = new Set<string>();
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** Jaccard 類似度 ∈ [0, 1]。どちらかの集合が空なら 0。 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  if (union === 0) return 0;
  return intersect / union;
}

/** 任意の DNA `value` ペイロードから最良の自由テキスト項目を取り出す。 */
export function extractRowText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const v = value as Record<string, unknown>;
  const candidates = [v.text, v.body, v.summary, v.description, v.title];
  for (const c of candidates) if (typeof c === "string" && c.length > 0) return c;
  return "";
}

// ─── Public API: checkPatternAlerts ─────────────────────────────────────────

export interface PatternAlertHit {
  /** DNA 行の複合キー（UI がディープリンクできるよう返す）。 */
  dnaType: PatternDnaType;
  key: string;
  source: string;
  /** DNA 行に永続化されている confidence（0..1）。 */
  confidence: number;
  /** 下書きとこの行のテキストの Jaccard 重なり（0..1）。 */
  similarity: number;
  /** value から取り出せた人間可読なテキスト（切り詰め済み）。 */
  excerpt: string;
}

export interface PatternAlertsResult {
  failureWarnings: PatternAlertHit[];
  successRecommendations: PatternAlertHit[];
  /** 走査対象になった DNA 行の総数（tenant + dnaType フィルタ後）。 */
  scanned: number;
  /** ヒット判定に使った Jaccard 類似度のしきい値（0..1）。 */
  threshold: number;
}

export interface CheckPatternAlertsArgs {
  tenantId: string;
  draftText: string;
  /** 任意の dnaType フィルタ — 省略時は 5 タイプ全て走査。 */
  dnaType?: PatternDnaType;
  /** ヒットに必要な最小 Jaccard 類似度。デフォルト 0.2。[0, 1] にクランプ。 */
  threshold?: number;
  /** バケットごとの最大ヒット数。デフォルト 3。[1, 10] にクランプ。 */
  maxHits?: number;
}

/** 1 リクエストあたりの走査行数の上限（病的なテナントから保護）。 */
export const PATTERN_ALERTS_SCAN_CAP = 500;

/**
 * 蓄積された DNA 行を下書きテキストと照合し、重なりの大きい失敗 / 成功行の
 * 上位 N 件を返す。
 *
 * 入力欠落・ストアエラー・しきい値未達のときは空だが整形済みの結果を返す —
 * 決して throw しない。
 */
export async function checkPatternAlerts(
  store: DnaStore,
  args: CheckPatternAlertsArgs,
): Promise<PatternAlertsResult> {
  const threshold = clamp01(args.threshold, 0.2);
  const maxHits = clampInt(args.maxHits, 1, 10, 3);

  const empty: PatternAlertsResult = {
    failureWarnings: [],
    successRecommendations: [],
    scanned: 0,
    threshold,
  };

  if (!args.tenantId || typeof args.draftText !== "string" || args.draftText.trim().length === 0) {
    return empty;
  }

  let rows;
  try {
    rows = await store.list(args.tenantId, {
      dnaType: args.dnaType && isPatternDnaType(args.dnaType) ? args.dnaType : undefined,
      limit: PATTERN_ALERTS_SCAN_CAP,
    });
  } catch {
    return empty;
  }
  if (!rows || rows.length === 0) return empty;

  const draftTokens = tokenize(args.draftText);
  if (draftTokens.size === 0) return { ...empty, scanned: rows.length };

  const failures: PatternAlertHit[] = [];
  const successes: PatternAlertHit[] = [];

  for (const row of rows) {
    const outcome = classifyOutcome(row.value);
    if (outcome === "neutral") continue;

    const text = extractRowText(row.value);
    if (text.length === 0) continue;

    const similarity = jaccardSimilarity(draftTokens, tokenize(text));
    if (similarity < threshold) continue;

    const hit: PatternAlertHit = {
      dnaType: (isPatternDnaType(row.dnaType) ? row.dnaType : "content") as PatternDnaType,
      key: row.key,
      source: row.source,
      confidence: clamp01(Number(row.confidence), 1),
      similarity,
      excerpt: truncate(text, 200),
    };
    if (outcome === "failure") failures.push(hit);
    else successes.push(hit);
  }

  // 類似度が高い順、同点なら confidence が高い順。
  const sortByScore = (a: PatternAlertHit, b: PatternAlertHit) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    return b.confidence - a.confidence;
  };
  failures.sort(sortByScore);
  successes.sort(sortByScore);

  return {
    failureWarnings: failures.slice(0, maxHits),
    successRecommendations: successes.slice(0, maxHits),
    scanned: rows.length,
    threshold,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
