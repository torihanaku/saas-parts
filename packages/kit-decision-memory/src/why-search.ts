/**
 * why-search.ts — 「なぜこうしたのか？」検索。
 *
 * 出典: 実運用SaaS server/lib/institutional-memory/why-search-service.ts
 * + server/routes/decisions/why.ts。
 * 本家は pgvector RPC（match_decisions_by_embedding）+ Claude 要約だったが、
 * キットでは EmbeddingSearcher（任意注入）→ 内蔵 BM25 フォールバックの
 * 二段構えにし、LLM 呼び出しは TextGenerator コールバックへ委譲した。
 */

import { normalizeScores, rankBm25 } from "./bm25.js";
import type { DecisionStore } from "./stores.js";
import {
  DecisionMemoryValidationError,
  NOOP_LOGGER,
  type EmbeddingSearcher,
  type KitLogger,
  type TextGenerator,
  type WhyCitation,
  type WhySearchResult,
} from "./types.js";

const DEFAULT_SYSTEM_PROMPT = `
あなたは組織の記憶装置です。
質問に対して、提供される過去の意思決定ログのみを根拠に回答してください。
根拠がない、または少ない場合は「十分な記録がありません」と正直に答えてください。
回答は 3-5 文、日本語で簡潔に。
各根拠には [ID: <decision_id の先頭 8 文字>] を付けてください。
`.trim();

export interface WhySearchServiceDeps {
  store: DecisionStore;
  /** セマンティック検索（任意）。未注入時は BM25 キーワード検索。 */
  searcher?: EmbeddingSearcher;
  /** 回答生成 LLM（任意）。未注入時は citations のみ返す。 */
  generateText?: TextGenerator;
  systemPrompt?: string;
  answerMaxTokens?: number;
  /** 記録ゼロ時の answer。 */
  noResultsMessage?: string;
  /** LLM 未注入時の answer。 */
  noLlmMessage?: string;
  /** 類似度の下限（searcher 使用時）。デフォルト 0.6。 */
  threshold?: number;
  logger?: KitLogger;
}

export interface WhySearchInput {
  tenantId: string;
  question: string;
  topK?: number;
}

export class WhySearchService {
  private readonly store: DecisionStore;
  private readonly searcher: EmbeddingSearcher | undefined;
  private readonly generateText: TextGenerator | undefined;
  private readonly systemPrompt: string;
  private readonly answerMaxTokens: number;
  private readonly noResultsMessage: string;
  private readonly noLlmMessage: string;
  private readonly threshold: number;
  private readonly logger: KitLogger;

  constructor(deps: WhySearchServiceDeps) {
    this.store = deps.store;
    this.searcher = deps.searcher;
    this.generateText = deps.generateText;
    this.systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.answerMaxTokens = deps.answerMaxTokens ?? 500;
    this.noResultsMessage =
      deps.noResultsMessage ?? "関連する意思決定の記録が見つかりませんでした。";
    this.noLlmMessage =
      deps.noLlmMessage ?? "AI 要約は無効です。関連する記録の一覧をご確認ください。";
    this.threshold = deps.threshold ?? 0.6;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  async search(input: WhySearchInput): Promise<WhySearchResult> {
    if (!input.question || !input.question.trim()) {
      throw new DecisionMemoryValidationError("question is required");
    }
    const topK = input.topK ?? 5;
    this.logger.info(
      "decision-memory.why-search",
      `searching for: "${input.question}" (tenant=${input.tenantId})`,
    );

    // 1. 候補の取得（セマンティック or BM25）
    let scored: Array<{ id: string; similarity: number }>;
    if (this.searcher) {
      scored = await this.searcher.search(input.question, {
        tenantId: input.tenantId,
        topK,
        threshold: this.threshold,
      });
    } else {
      const decisions = await this.store.list(input.tenantId);
      const hits = rankBm25(
        decisions.map((d) => ({
          id: d.id,
          text: `${d.subject}\n${d.context}\n${d.reason}`,
        })),
        input.question,
        { topK },
      );
      scored = normalizeScores(hits);
    }

    // 2. ストアからハイドレート
    const citations: WhyCitation[] = [];
    const contextBlocks: string[] = [];
    for (const hit of scored) {
      const d = await this.store.getById(input.tenantId, hit.id);
      if (!d) continue;
      citations.push({
        decisionId: d.id,
        decisionType: d.decisionType,
        subject: d.subject,
        decidedAt: d.decidedAt,
        similarity: hit.similarity,
      });
      contextBlocks.push(
        `[ID: ${d.id.slice(0, 8)}] 種別=${d.decisionType} / 対象=${d.subject} / 日付=${d.decidedAt}\n` +
          `根拠: ${d.reason}\n文脈: ${d.context ?? ""}\n`,
      );
    }

    if (citations.length === 0) {
      return { answer: this.noResultsMessage, citations: [], hasAnswer: false };
    }

    // 3. LLM 回答生成（任意）
    if (!this.generateText) {
      return { answer: this.noLlmMessage, citations, hasAnswer: true };
    }

    const answer = await this.generateText(
      this.systemPrompt,
      `質問: ${input.question}\n\n過去の意思決定ログ:\n${contextBlocks.join("\n---\n")}`,
      { maxTokens: this.answerMaxTokens },
    );
    return {
      answer: answer || "回答を生成できませんでした。",
      citations,
      hasAnswer: true,
    };
  }
}
