/**
 * Q&A エンジン「Ask the Chief of Staff」（元: server/lib/cos/qa-engine.ts, COS-6）。
 *
 * 自然文の質問 →
 *   1. （任意）埋め込みベクトルで意思決定ログをセマンティック検索
 *      （元: pgvector `match_decisions_by_embedding` RPC。DecisionSearcher に注入化）
 *   2. digest を新着 + relevance でフィルタ（30 日 / relevance >= 0.5）
 *   3. LLM が引用付き [source, id] で回答を合成
 *
 * どちらの候補プールも空なら hasAnswer=false（丁寧な「記録なし」文言）を返し、
 * 決して捏造しない。
 */
import type { CosLogger, CosSourceType, Embedder, LlmCaller } from "./types";
import type { DigestStore } from "./stores";

// ─── 公開型 ──────────────────────────────────────────────────────────────────

export interface QaInput {
  tenantId: string;
  question: string;
  /** 既定 8。プロンプトサイズとコストを抑えるため 20 で hard cap。 */
  topK?: number;
}

export type QaCitationSource = "cos_digest" | "decision_log";

export interface QaCitation {
  source: QaCitationSource;
  id: string;
  /** digest 引用の permalink。decision は null。 */
  sourcePermalink: string | null;
  /** digest は要約、decision は "<subject>: <reason>"。 */
  summaryOrReason: string;
  /** digest は 0（埋め込み未対応）。decision はコサイン類似度。 */
  similarity: number;
  /** digest 引用のみ設定。 */
  sourceType?: CosSourceType;
}

export interface QaOutput {
  answer: string;
  citations: QaCitation[];
  hasAnswer: boolean;
}

export class QaFlagDisabledError extends Error {
  constructor() {
    super("chiefOfStaff feature flag is disabled");
    this.name = "QaFlagDisabledError";
  }
}

/** 意思決定ログ検索の注入点（元: pgvector RPC）。 */
export interface DecisionMatch {
  id: string;
  decisionType: string;
  subject: string;
  reason: string;
  similarity: number;
}

export interface DecisionSearcher {
  search(tenantId: string, embedding: number[], topK: number): Promise<DecisionMatch[]>;
}

// ─── 内部定数 ─────────────────────────────────────────────────────────────────

export const QA_SYSTEM_PROMPT = `
あなたは組織の AI チーフオブスタッフです。
質問に対し、提供される資料 (Slack/会議/メールの digest + 意思決定ログ) のみを根拠に日本語で回答してください。
根拠が見つからない、または資料が質問と無関係な場合は「該当する記録が見つかりませんでした」と正直に答えてください。
推測や捏造は禁止です。
回答は 3-6 文で簡潔に、各根拠に [source: <source_type>, id: <short-id>] を付けてください。
`.trim();

const TOP_K_DEFAULT = 8;
const TOP_K_MAX = 20;
const DIGEST_LOOKBACK_DAYS = 30;
const DIGEST_RELEVANCE_FLOOR = 0.5;
const DIGEST_CANDIDATE_LIMIT = 30;
export const QA_NO_RESULT_MESSAGE =
  "該当する記録が見つかりませんでした。Slack/会議/メール/意思決定ログのいずれにも関連情報が無いようです。";
export const QA_NO_LLM_MESSAGE =
  "AI 要約機能を実行できません（API キー未設定）。下記の根拠候補をご確認ください。";

export function clampTopK(raw: number | undefined): number {
  const k = raw ?? TOP_K_DEFAULT;
  if (!Number.isFinite(k) || k <= 0) return TOP_K_DEFAULT;
  return Math.min(Math.floor(k), TOP_K_MAX);
}

interface DigestCandidate {
  id: string;
  sourceType: CosSourceType;
  sourcePermalink: string | null;
  summary: string;
}

function buildDigestPromptLines(rows: DigestCandidate[]): string[] {
  return rows.map(
    (d) => `[source: cos_digest, id: ${d.id.slice(0, 8)}] (${d.sourceType}) ${d.summary}`,
  );
}

function buildDecisionPromptLines(rows: DecisionMatch[]): string[] {
  return rows.map(
    (n) =>
      `[source: decision_log, id: ${n.id.slice(0, 8)}] (${n.decisionType}) ${n.subject}: ${n.reason}`,
  );
}

function toDigestCitations(rows: DigestCandidate[]): QaCitation[] {
  return rows.map((d) => ({
    source: "cos_digest" as const,
    id: d.id,
    sourcePermalink: d.sourcePermalink,
    summaryOrReason: d.summary,
    similarity: 0,
    sourceType: d.sourceType,
  }));
}

function toDecisionCitations(rows: DecisionMatch[]): QaCitation[] {
  return rows.map((n) => ({
    source: "decision_log" as const,
    id: n.id,
    sourcePermalink: null,
    summaryOrReason: `${n.subject}: ${n.reason}`,
    similarity: typeof n.similarity === "number" ? n.similarity : 0,
  }));
}

function emptyResult(): QaOutput {
  return { answer: QA_NO_RESULT_MESSAGE, citations: [], hasAnswer: false };
}

// ─── エンジン ─────────────────────────────────────────────────────────────────

export interface QaEngineDeps {
  digestStore: DigestStore;
  /** 未注入時は引用候補のみ返す（「APIキー未設定」文言） */
  llm?: LlmCaller;
  /** embedder + decisionSearcher が両方あるときのみ意思決定ログを検索する */
  embedder?: Embedder;
  decisionSearcher?: DecisionSearcher;
  /** 機能フラグの注入点。false を返すと QaFlagDisabledError。既定は常に有効。 */
  isEnabled?: () => boolean;
  logger?: CosLogger;
}

export class QaEngine {
  private readonly deps: QaEngineDeps;
  private readonly log: CosLogger;

  constructor(deps: QaEngineDeps) {
    this.deps = deps;
    this.log = deps.logger ?? (() => {});
  }

  private async fetchDigestCandidates(
    tenantId: string,
    topK: number,
  ): Promise<DigestCandidate[]> {
    const sinceIso = new Date(
      Date.now() - DIGEST_LOOKBACK_DAYS * 24 * 3600 * 1000,
    ).toISOString();
    const limit = Math.min(DIGEST_CANDIDATE_LIMIT, Math.max(topK * 3, 10));

    const rows = await this.deps.digestStore.query(tenantId, {
      sinceIso,
      minRelevance: DIGEST_RELEVANCE_FLOOR,
      orderBy: "ingestedAt",
      limit,
    });
    return rows.map((r) => ({
      id: r.id,
      sourceType: r.sourceType,
      sourcePermalink: r.sourcePermalink,
      summary: r.summary,
    }));
  }

  private async fetchDecisionNeighbors(
    tenantId: string,
    question: string,
    topK: number,
  ): Promise<DecisionMatch[]> {
    if (!this.deps.embedder || !this.deps.decisionSearcher) return [];
    const embedding = await this.deps.embedder(question);
    return this.deps.decisionSearcher.search(tenantId, embedding, topK);
  }

  /**
   * Q&A パイプラインを実行する。フラグ無効時は QaFlagDisabledError を throw。
   * その他の失敗（検索・埋め込み）は呼び出し側に伝播する。
   */
  async ask(input: QaInput): Promise<QaOutput> {
    if (this.deps.isEnabled && !this.deps.isEnabled()) {
      throw new QaFlagDisabledError();
    }

    const question = (input.question ?? "").trim();
    if (!question) {
      return emptyResult();
    }
    const topK = clampTopK(input.topK);

    this.log("INFO", "cos_qa_ask", {
      tenant_id: input.tenantId,
      top_k: topK,
      q_len: question.length,
    });

    const [digestCandidates, decisionNeighbors] = await Promise.all([
      this.fetchDigestCandidates(input.tenantId, topK),
      this.fetchDecisionNeighbors(input.tenantId, question, topK),
    ]);

    const totalEvidence = digestCandidates.length + decisionNeighbors.length;
    if (totalEvidence === 0) {
      return emptyResult();
    }

    // digest がノイジーでも decision のセマンティック一致を押し出さないよう
    // 双方 topK で bound する。
    const digestForPrompt = digestCandidates.slice(0, topK);
    const decisionForPrompt = decisionNeighbors.slice(0, topK);

    const promptLines = [
      ...buildDigestPromptLines(digestForPrompt),
      ...buildDecisionPromptLines(decisionForPrompt),
    ];

    const citations: QaCitation[] = [
      ...toDigestCitations(digestForPrompt),
      ...toDecisionCitations(decisionForPrompt),
    ];

    if (!this.deps.llm) {
      this.log("ERROR", "cos_qa_no_llm", { tenant_id: input.tenantId });
      return { answer: QA_NO_LLM_MESSAGE, citations, hasAnswer: true };
    }

    const userPrompt = `質問: ${question}\n\n資料:\n${promptLines.join("\n")}`;
    const answer = await this.deps.llm.generateText(QA_SYSTEM_PROMPT, userPrompt, {
      maxTokens: 800,
    });

    if (!answer) {
      return {
        answer: "回答を生成できませんでした。後ほど再度お試しください。",
        citations,
        hasAnswer: true,
      };
    }

    return { answer, citations, hasAnswer: true };
  }
}
