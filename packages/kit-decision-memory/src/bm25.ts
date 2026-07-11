/**
 * bm25.ts — 汎用 BM25 キーワードランキング（キット内プライベート実装）。
 *
 * 出典メモ: dev-dashboard-v2 の server/lib/bm25.ts はキャラクター×スキル
 * マッチング専用（TF=1 前提・proficiency 重み付き）で、意思決定 why 検索は
 * 本家では pgvector を使っており BM25 に依存していなかった。
 * 本キットでは「EmbeddingSearcher 未注入でも動く自己完結キット」にするため、
 * 定数（k1=1.5, b=0.75）と設計方針のみ引き継いだ汎用文書版を私製した。
 *
 * score(D, Q) = Σ_t IDF(t) × TF(t,D)×(k1+1) / (TF(t,D) + k1×(1-b+b×|D|/avgdl))
 * IDF(t) = ln(1 + (N - df + 0.5) / (df + 0.5))
 *
 * 日本語対応: CJK 連続文字列は 2-gram に分解してトークン化する。
 */

export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

const LATIN_WORD = /[a-z0-9_]+/g;
const CJK_RUN = /[぀-ヿ㐀-鿿豈-﫿]+/g;

/** 英数字は単語、CJK は 2-gram でトークン化（小文字化・順序不問）。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(LATIN_WORD)) tokens.push(m[0]);
  for (const m of lower.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

export interface Bm25Doc {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  /** 生の BM25 スコア（>0 のみ返す）。 */
  score: number;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
  topK?: number;
}

/**
 * クエリに対して文書群を BM25 でランキングする。
 * score > 0 のみ、スコア降順（同点は id 昇順）で返す決定的な実装。
 */
export function rankBm25(docs: Bm25Doc[], query: string, options: Bm25Options = {}): Bm25Hit[] {
  const k1 = options.k1 ?? BM25_K1;
  const b = options.b ?? BM25_B;
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0 || docs.length === 0) return [];

  // 各文書の term frequency と長さ
  const docTf: Array<{ id: string; tf: Map<string, number>; len: number }> = [];
  let totalLen = 0;
  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    docTf.push({ id: doc.id, tf, len: tokens.length });
    totalLen += tokens.length;
  }
  const avgdl = totalLen / docs.length || 1;
  const n = docs.length;

  // document frequency → IDF
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    let df = 0;
    for (const d of docTf) if (d.tf.has(term)) df++;
    idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  const hits: Bm25Hit[] = [];
  for (const d of docTf) {
    let score = 0;
    for (const term of queryTerms) {
      const tf = d.tf.get(term) ?? 0;
      if (tf === 0) continue;
      const denom = tf + k1 * (1 - b + b * (d.len / avgdl));
      score += (idf.get(term) ?? 0) * ((tf * (k1 + 1)) / denom);
    }
    if (score > 0) hits.push({ id: d.id, score });
  }

  hits.sort((a, z) => (z.score - a.score) || (a.id < z.id ? -1 : a.id > z.id ? 1 : 0));
  const topK = options.topK;
  return typeof topK === "number" && topK > 0 ? hits.slice(0, topK) : hits;
}

/** 最上位を 1.0 とした正規化スコア（similarity 互換値）に変換する。 */
export function normalizeScores(hits: Bm25Hit[]): Array<{ id: string; similarity: number }> {
  const max = hits[0]?.score;
  if (!max || max <= 0) return [];
  return hits.map((h) => ({ id: h.id, similarity: h.score / max }));
}
