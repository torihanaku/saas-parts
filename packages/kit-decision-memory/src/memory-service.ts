/**
 * memory-service.ts — 組織記憶（ナレッジ蓄積 + 検索）のコアサービス。
 *
 * 出典: dev-dashboard-v2 server/lib/institutional-memory.ts
 * （logMemory / searchMemory / getMemoryByType）。
 * Supabase / embedding パイプライン / Claude 直結を注入インターフェースに
 * 置き換え、mem_type と検索プロンプトをパラメータ化した。
 */

import { normalizeScores, rankBm25 } from "./bm25.js";
import type { MemoryStore } from "./stores.js";
import {
  DEFAULT_MEM_TYPES,
  DecisionMemoryValidationError,
  NOOP_LOGGER,
  resolveContext,
  type Embedder,
  type EmbeddingSearcher,
  type KitLogger,
  type LogMemoryInput,
  type MemoryItem,
  type SearchMemoryOptions,
  type SearchMemoryResult,
  type ServiceContext,
  type TextGenerator,
} from "./types.js";

const MAX_SUBJECT_LEN = 500;
const MAX_CONTENT_LEN = 20_000;

const DEFAULT_SEARCH_SYSTEM_PROMPT = `
あなたは組織の記憶装置です。
質問と関連する過去の記録（意思決定 / 失敗事例 / 成功レシピ）を要約してください。
ルール:
- 提供された記録のみを根拠にする。憶測禁止
- 日本語、3-5 文、400 字以内
- 各根拠には [#<id の先頭 8 文字>] を必ず付ける
- 記録が薄い場合は「十分な記録がありません」と正直に答える
`.trim();

export interface InstitutionalMemoryServiceDeps {
  store: MemoryStore;
  /** 保存時に埋め込みを計算してストアへ渡す（任意）。 */
  embedder?: Embedder;
  /** セマンティック検索。未注入時は内蔵 BM25 キーワード検索。 */
  searcher?: EmbeddingSearcher;
  /** 検索結果の LLM 要約（任意）。 */
  generateText?: TextGenerator;
  /** 許可する mem_type 一覧。デフォルト: decision_log / failure_recipe / success_recipe。 */
  memTypes?: readonly string[];
  searchSystemPrompt?: string;
  summaryMaxTokens?: number;
  logger?: KitLogger;
  context?: ServiceContext;
}

export class InstitutionalMemoryService {
  private readonly store: MemoryStore;
  private readonly embedder: Embedder | undefined;
  private readonly searcher: EmbeddingSearcher | undefined;
  private readonly generateText: TextGenerator | undefined;
  private readonly memTypes: readonly string[];
  private readonly searchSystemPrompt: string;
  private readonly summaryMaxTokens: number;
  private readonly logger: KitLogger;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(deps: InstitutionalMemoryServiceDeps) {
    this.store = deps.store;
    this.embedder = deps.embedder;
    this.searcher = deps.searcher;
    this.generateText = deps.generateText;
    this.memTypes = deps.memTypes ?? DEFAULT_MEM_TYPES;
    this.searchSystemPrompt = deps.searchSystemPrompt ?? DEFAULT_SEARCH_SYSTEM_PROMPT;
    this.summaryMaxTokens = deps.summaryMaxTokens ?? 600;
    this.logger = deps.logger ?? NOOP_LOGGER;
    const ctx = resolveContext(deps.context);
    this.now = ctx.now;
    this.generateId = ctx.generateId;
  }

  isMemType(value: unknown): value is string {
    return typeof value === "string" && this.memTypes.includes(value);
  }

  // ── logMemory ─────────────────────────────────────────────────────────────
  /**
   * ナレッジを 1 件保存する。embedder が注入されていれば
   * `${subject}\n\n${content}` の埋め込みを計算してストアへ渡す。
   */
  async logMemory(tenantId: string, input: LogMemoryInput): Promise<MemoryItem> {
    this.validateLogInput(input);

    let embedding: number[] | null = null;
    if (this.embedder) {
      embedding = await this.embedder.embed(`${input.subject}\n\n${input.content}`);
    }

    const nowIso = this.now().toISOString();
    const item: MemoryItem = {
      id: this.generateId(),
      tenantId,
      memType: input.memType,
      subject: input.subject,
      content: input.content,
      source: input.source ?? null,
      decidedBy: input.decidedBy ?? null,
      decidedAt: input.decidedAt ?? nowIso,
      createdAt: nowIso,
    };
    await this.store.insert(item, embedding);
    this.logger.info(
      "decision-memory.logMemory",
      `inserted mem_type=${input.memType} tenant=${tenantId} id=${item.id}`,
    );
    return item;
  }

  // ── searchMemory ──────────────────────────────────────────────────────────
  /**
   * why 検索の中核。searcher（セマンティック）があればそれを、なければ
   * BM25 キーワード検索を使う。generateText が注入されていれば要約も生成。
   */
  async searchMemory(
    tenantId: string,
    query: string,
    options: SearchMemoryOptions = {},
  ): Promise<SearchMemoryResult> {
    if (!query || !query.trim()) {
      throw new DecisionMemoryValidationError("query (q) is required");
    }
    const topK = clampTopK(options.topK);
    const threshold = options.threshold ?? 0.6;

    let scored: Array<{ id: string; similarity: number }>;
    if (this.searcher) {
      const searchOpts: { tenantId: string; topK: number; threshold: number; memType?: string } = {
        tenantId,
        topK,
        threshold,
      };
      if (options.memType !== undefined) searchOpts.memType = options.memType;
      scored = await this.searcher.search(query, searchOpts);
    } else {
      const candidates = (await this.store.listByTenant(tenantId)).filter(
        (i) => !options.memType || i.memType === options.memType,
      );
      const hits = rankBm25(
        candidates.map((i) => ({ id: i.id, text: `${i.subject}\n${i.content}` })),
        query,
        { topK },
      );
      scored = normalizeScores(hits);
    }

    const rows: MemoryItem[] = [];
    for (const hit of scored) {
      const item = await this.store.getById(tenantId, hit.id);
      if (item) rows.push({ ...item, similarity: hit.similarity });
    }
    if (rows.length === 0) return { results: [], summary: "" };
    if (!this.generateText) return { results: rows, summary: "" };

    const summary = await this.safeGenerate(
      this.searchSystemPrompt,
      buildRerankPrompt(query, rows),
    );
    return { results: rows, summary };
  }

  // ── getMemoryByType ───────────────────────────────────────────────────────
  /** mem_type ごとの時系列取得（失敗博物館 / 成功レシピの一覧向け）。 */
  async getMemoryByType(tenantId: string, memType: string, limit = 50): Promise<MemoryItem[]> {
    if (!this.isMemType(memType)) {
      throw new DecisionMemoryValidationError(
        `mem_type must be one of: ${this.memTypes.join(", ")}`,
      );
    }
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
    return this.store.listByType(tenantId, memType, safeLimit);
  }

  // ── internal ──────────────────────────────────────────────────────────────
  private validateLogInput(input: LogMemoryInput): void {
    if (!this.isMemType(input.memType)) {
      throw new DecisionMemoryValidationError(
        `mem_type must be one of: ${this.memTypes.join(", ")}`,
      );
    }
    if (!input.subject || typeof input.subject !== "string" || !input.subject.trim()) {
      throw new DecisionMemoryValidationError("subject is required");
    }
    if (input.subject.length > MAX_SUBJECT_LEN) {
      throw new DecisionMemoryValidationError(`subject exceeds ${MAX_SUBJECT_LEN} characters`);
    }
    if (!input.content || typeof input.content !== "string" || !input.content.trim()) {
      throw new DecisionMemoryValidationError("content is required");
    }
    if (input.content.length > MAX_CONTENT_LEN) {
      throw new DecisionMemoryValidationError(`content exceeds ${MAX_CONTENT_LEN} characters`);
    }
    if (input.decidedAt && Number.isNaN(Date.parse(input.decidedAt))) {
      throw new DecisionMemoryValidationError("decided_at must be a valid ISO-8601 timestamp");
    }
  }

  private async safeGenerate(system: string, user: string): Promise<string> {
    if (!this.generateText) return "";
    try {
      const text = await this.generateText(system, user, { maxTokens: this.summaryMaxTokens });
      return text || "";
    } catch (err) {
      this.logger.error("decision-memory.searchMemory.summary", err);
      return "";
    }
  }
}

function clampTopK(topK?: number): number {
  if (typeof topK !== "number" || !Number.isFinite(topK) || topK <= 0) return 5;
  return Math.min(Math.floor(topK), 20);
}

export function buildRerankPrompt(query: string, rows: MemoryItem[]): string {
  const evidence = rows
    .map(
      (r) =>
        `[#${r.id.slice(0, 8)}] type=${r.memType} subject=${r.subject} decided_at=${r.decidedAt}\n` +
        `content: ${r.content}`,
    )
    .join("\n---\n");
  return `質問: ${query}\n\n関連する記録:\n${evidence}`;
}
