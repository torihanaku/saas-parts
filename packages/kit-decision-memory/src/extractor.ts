/**
 * extractor.ts — 自由文（チャット / 会議書き起こし等）からの意思決定抽出。
 *
 * 出典: 実運用SaaS server/lib/institutional-memory/decision-extractor.ts。
 * 本家は Claude 直結（generateJson）+ Supabase + pgvector dedup だったが、
 * キットでは LLM を JsonGenerator コールバック、埋め込みを Embedder、
 * 類似重複検知を EmbeddingSearcher（いずれも注入）に置き換えた。
 * Slack / Notion 固有の取得部（slack-extractor.ts / notion-extractor.ts）は
 * 落とし、`SourceExtractor` インターフェースとして形だけ残した（README 参照）。
 */

import type { DecisionStore } from "./stores.js";
import {
  DEFAULT_DECISION_TYPES,
  NOOP_LOGGER,
  resolveContext,
  type DecisionRecord,
  type Embedder,
  type EmbeddingSearcher,
  type KitLogger,
  type ServiceContext,
} from "./types.js";

// ── 注入ポイント ────────────────────────────────────────────────────────────
/**
 * LLM の JSON モード呼び出し。system + user プロンプトを受け取り、
 * パース済みのオブジェクト（失敗時は null 等）を返す。
 */
export type JsonGenerator = (
  system: string,
  user: string,
  opts?: { maxTokens?: number },
) => Promise<unknown>;

/**
 * 外部ソース（Slack / Notion / 議事録 SaaS 等）からの取り込み口。
 * 本家の slack-extractor / notion-extractor はこの形の実装だった。
 * キット本体は実装を持たない — 利用側が用意して
 * `DecisionExtractorService.extract()` へ流し込む。
 */
export interface SourceExtractor {
  /** ソース名（'slack' / 'notion' / 'meeting' など）。 */
  readonly source: string;
  /** 取り込み対象のメッセージ群を列挙する。 */
  fetchCandidates(tenantId: string): Promise<
    Array<{
      /** 元メッセージへの参照（permalink / page id 等）。 */
      sourceRef: string;
      rawText: string;
      /** ISO-8601。省略時は now()。 */
      decidedAt?: string;
    }>
  >;
}

// ── 型 ──────────────────────────────────────────────────────────────────────
export interface ExtractedDecision {
  found: boolean;
  type: string | null;
  subject: string | null;
  context: string | null;
  reason: string | null;
  alternatives_considered?: string | null;
  confidence: number;
}

export interface ExtractionInput {
  tenantId: string;
  /** 抽出元ソース名（'slack' / 'meeting' など自由文字列）。 */
  source: string;
  /** permalink / transcript_id 等。dedup layer 1 のキー。 */
  sourceRef: string;
  rawText: string;
  /** ISO-8601。省略時は now()。 */
  decidedAt?: string;
}

export type ExtractionSkipReason =
  | "inserted"
  | "no_decision_found"
  | "low_confidence"
  | "duplicate"
  | "invalid_response";

export interface ExtractionResult {
  inserted: boolean;
  decision: DecisionRecord | null;
  reason: ExtractionSkipReason;
}

// ── 定数（本家と同値・すべてパラメータ化可能） ──────────────────────────────
export const DEFAULT_MIN_CONFIDENCE = 0.6;
export const DEFAULT_DUP_SIMILARITY_THRESHOLD = 0.92;
export const DEFAULT_DUP_WINDOW_DAYS = 30;
export const DEFAULT_MAX_INPUT_CHARS = 4000;

const DEFAULT_SYSTEM_PROMPT = `あなたは組織の意思決定アーキビストです。
入力されたチャットメッセージまたは会議書き起こしから、組織としての「意思決定」を抽出してください。
意思決定とは "○○を始める / やめる / 変える / 軸を変える / 一旦止める" 等、 方針や行動を明示的に変更する宣言です。
雑談・質問・観察・愚痴・未確定の検討は found=false とします。
記録に残された事実のみを抽出し、 行間を勝手に補完してはいけません。

出力は次の JSON のみ (markdown / 説明文を一切含めない):
{
  "found": boolean,
  "type": "start" | "stop" | "change" | "pivot" | "archive" | null,
  "subject": string | null,
  "context": string | null,
  "reason": string | null,
  "alternatives_considered": string | null,
  "confidence": number
}
- subject: 何について (例: "Facebook 広告", "週次レポート")
- context: 決定時の状況 (1-2 文)
- reason: なぜそうしたか (1-2 文)
- alternatives_considered: 検討された代替案 (なければ null)
- confidence: 0.0-1.0 (記述の明確さ)`;

// ── ヘルパー ────────────────────────────────────────────────────────────────
function fallbackResult(): ExtractedDecision {
  return {
    found: false,
    type: null,
    subject: null,
    context: null,
    reason: null,
    alternatives_considered: null,
    confidence: 0,
  };
}

export function normalizeExtraction(
  parsed: unknown,
  validTypes: ReadonlySet<string>,
): ExtractedDecision {
  if (!parsed || typeof parsed !== "object") return fallbackResult();
  const p = parsed as Record<string, unknown>;
  const type = typeof p.type === "string" && validTypes.has(p.type) ? p.type : null;
  const confidence =
    typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : 0;
  return {
    found: p.found === true,
    type,
    subject: typeof p.subject === "string" ? p.subject.trim() : null,
    context: typeof p.context === "string" ? p.context.trim() : null,
    reason: typeof p.reason === "string" ? p.reason.trim() : null,
    alternatives_considered:
      typeof p.alternatives_considered === "string" ? p.alternatives_considered.trim() : null,
    confidence,
  };
}

// ── サービス ────────────────────────────────────────────────────────────────
export interface DecisionExtractorServiceDeps {
  store: DecisionStore;
  /** LLM JSON 抽出（必須）。 */
  generateJson: JsonGenerator;
  /** dedup layer 2 と将来の why 検索リコール用の埋め込み（任意）。 */
  embedder?: Embedder;
  /** 類似重複検知（任意）。未注入なら sourceRef 完全一致のみで dedup。 */
  dupSearcher?: EmbeddingSearcher;
  /** 許可する decision カテゴリ。デフォルト: start/stop/change/pivot/archive。 */
  decisionTypes?: readonly string[];
  systemPrompt?: string;
  minConfidence?: number;
  dupSimilarityThreshold?: number;
  dupWindowDays?: number;
  maxInputChars?: number;
  maxTokens?: number;
  /** 登録後フック（本家: バイアス検知キュー投入）。 */
  onDecisionRecorded?: (decision: DecisionRecord) => void | Promise<void>;
  logger?: KitLogger;
  context?: ServiceContext;
}

export class DecisionExtractorService {
  private readonly store: DecisionStore;
  private readonly generateJson: JsonGenerator;
  private readonly embedder: Embedder | undefined;
  private readonly dupSearcher: EmbeddingSearcher | undefined;
  private readonly validTypes: ReadonlySet<string>;
  private readonly systemPrompt: string;
  private readonly minConfidence: number;
  private readonly dupSimilarityThreshold: number;
  private readonly dupWindowDays: number;
  private readonly maxInputChars: number;
  private readonly maxTokens: number;
  private readonly onDecisionRecorded:
    | ((decision: DecisionRecord) => void | Promise<void>)
    | undefined;
  private readonly logger: KitLogger;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(deps: DecisionExtractorServiceDeps) {
    this.store = deps.store;
    this.generateJson = deps.generateJson;
    this.embedder = deps.embedder;
    this.dupSearcher = deps.dupSearcher;
    this.validTypes = new Set(deps.decisionTypes ?? DEFAULT_DECISION_TYPES);
    this.systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.minConfidence = deps.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.dupSimilarityThreshold = deps.dupSimilarityThreshold ?? DEFAULT_DUP_SIMILARITY_THRESHOLD;
    this.dupWindowDays = deps.dupWindowDays ?? DEFAULT_DUP_WINDOW_DAYS;
    this.maxInputChars = deps.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.maxTokens = deps.maxTokens ?? 600;
    this.onDecisionRecorded = deps.onDecisionRecorded;
    this.logger = deps.logger ?? NOOP_LOGGER;
    const ctx = resolveContext(deps.context);
    this.now = ctx.now;
    this.generateId = ctx.generateId;
  }

  /**
   * 1 件のテキストから意思決定を抽出し、confidence が十分かつ重複でなければ
   * ストアへ登録する。
   */
  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const userPrompt = `ソース種別: ${input.source}\n参照: ${input.sourceRef}\n\n本文:\n${this.truncate(input.rawText)}`;

    let parsed: unknown;
    try {
      parsed = await this.generateJson(this.systemPrompt, userPrompt, {
        maxTokens: this.maxTokens,
      });
    } catch (err) {
      this.logger.error("decision-memory.extractor.generateJson", err);
      return { inserted: false, decision: null, reason: "invalid_response" };
    }
    const ext = normalizeExtraction(parsed, this.validTypes);

    if (!ext.found || !ext.type || !ext.subject || !ext.reason) {
      return { inserted: false, decision: null, reason: "no_decision_found" };
    }
    if (ext.confidence < this.minConfidence) {
      this.logger.info(
        "decision-memory.extractor",
        `low_confidence skipped tenant=${input.tenantId} ref=${input.sourceRef} c=${ext.confidence}`,
      );
      return { inserted: false, decision: null, reason: "low_confidence" };
    }

    // dedup + 将来の why 検索リコール用の埋め込み（失敗しても続行）
    let embedding: number[] | null = null;
    if (this.embedder) {
      try {
        embedding = await this.embedder.embed(`${ext.type} ${ext.subject} ${ext.reason}`);
      } catch (err) {
        this.logger.error("decision-memory.extractor.embed", err);
      }
    }

    if (await this.isDuplicate(input, ext)) {
      this.logger.info(
        "decision-memory.extractor",
        `duplicate_skipped tenant=${input.tenantId} ref=${input.sourceRef}`,
      );
      return { inserted: false, decision: null, reason: "duplicate" };
    }

    const nowIso = this.now().toISOString();
    const decision: DecisionRecord = {
      id: this.generateId(),
      tenantId: input.tenantId,
      decisionType: ext.type,
      subject: ext.subject,
      context: ext.context ?? "(自動抽出: 文脈情報なし)",
      reason: ext.reason,
      alternativesConsidered: ext.alternatives_considered ?? null,
      decidedBy: null,
      decidedAt: input.decidedAt ?? nowIso,
      source: input.source,
      sourceRef: input.sourceRef,
      createdAt: nowIso,
      updatedAt: null,
    };
    await this.store.insert(decision, embedding);
    this.logger.info(
      "decision-memory.extractor",
      `inserted tenant=${input.tenantId} type=${ext.type} ref=${input.sourceRef}`,
    );
    if (this.onDecisionRecorded) {
      try {
        void Promise.resolve(this.onDecisionRecorded(decision)).catch((err) => {
          this.logger.error("decision-memory.extractor.onDecisionRecorded", err);
        });
      } catch (err) {
        this.logger.error("decision-memory.extractor.onDecisionRecorded", err);
      }
    }
    return { inserted: true, decision, reason: "inserted" };
  }

  /**
   * 重複判定（本家と同じ二層）:
   *  1. sourceRef 完全一致（すでに取り込み済み）
   *  2. 直近 dupWindowDays 日以内・同 type・類似度 >= dupSimilarityThreshold
   *     （dupSearcher 注入時のみ。失敗時は重複でない扱い）
   */
  private async isDuplicate(input: ExtractionInput, ext: ExtractedDecision): Promise<boolean> {
    const all = await this.store.list(input.tenantId);
    if (all.some((d) => d.sourceRef === input.sourceRef)) return true;

    if (!this.dupSearcher || !ext.type || !ext.subject || !ext.reason) return false;
    try {
      const neighbors = await this.dupSearcher.search(
        `${ext.type} ${ext.subject} ${ext.reason}`,
        {
          tenantId: input.tenantId,
          topK: 5,
          threshold: this.dupSimilarityThreshold,
        },
      );
      const cutoff = this.now().getTime() - this.dupWindowDays * 24 * 60 * 60 * 1000;
      for (const n of neighbors) {
        const existing = await this.store.getById(input.tenantId, n.id);
        if (!existing || existing.decisionType !== ext.type) continue;
        const decided = new Date(existing.decidedAt).getTime();
        if (Number.isFinite(decided) && decided >= cutoff) return true;
      }
      return false;
    } catch (err) {
      this.logger.error("decision-memory.extractor.dedup", err);
      return false;
    }
  }

  private truncate(text: string): string {
    return text.length > this.maxInputChars ? text.slice(0, this.maxInputChars) : text;
  }
}
