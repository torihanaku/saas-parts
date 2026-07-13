/**
 * onboarding-persona.ts — 新任者向けオンボーディング AI ペルソナ（MEM-5）。
 *
 * 出典: 実運用SaaS server/lib/institutional-memory/onboarding-persona.ts。
 * 全 mem_type（decision_log / failure_recipe / success_recipe）を統合して
 * 「この組織はどう動いてきたか」を会話形式で説明する。
 * onboarding.ts の explainTopic（dd_decision_log ベースの単発要約）とは別物。
 * Claude 直結 → TextGenerator 注入、searchMemory / getMemoryByType →
 * InstitutionalMemoryService 経由に置き換え、ペルソナプロンプトの製品名は
 * 汎用化した。
 */

import type { InstitutionalMemoryService } from "./memory-service.js";
import {
  DEFAULT_MEM_TYPES,
  DecisionMemoryValidationError,
  NOOP_LOGGER,
  type KitLogger,
  type MemoryItem,
  type TextGenerator,
} from "./types.js";

// ── 型 ──────────────────────────────────────────────────────────────────────
export interface OnboardingTurn {
  role: "user" | "assistant";
  content: string;
}

export interface OnboardingAnswerInput {
  tenantId: string;
  question: string;
  /** 過去の会話ターン（古い順）。サービス側で直近 10 件に丸める。 */
  conversationHistory?: OnboardingTurn[];
}

export interface OnboardingCitation {
  /** 回答本文で使う短縮参照 — `[#xxxxxxxx]` */
  ref: string;
  /** UI がリンク / 展開に使うフル ID */
  id: string;
  memType: string;
  subject: string;
  decidedAt: string;
}

export interface OnboardingAnswer {
  answer: string;
  citations: OnboardingCitation[];
  /** mem_type ごとの根拠件数。 */
  evidenceCounts: Record<string, number>;
  suggestedFollowUps: string[];
}

// ── 定数（本家と同値） ──────────────────────────────────────────────────────
const MAX_QUESTION_LEN = 2_000;
const MAX_HISTORY_TURNS = 10;
const PER_TYPE_TIME_TOPK = 5;
const SEARCH_TOPK = 8;
const SEARCH_THRESHOLD = 0.55;
const MAX_EVIDENCE = 18;
const FOLLOW_UP_MARKER = "### 次に聞くと良い質問";

const DEFAULT_PERSONA_PROMPT = `
あなたは新任メンバー向けオンボーディング AI です。
役割: 組織の方針・過去の主要決定・失敗から得た教訓・成功レシピを統合して、新しく入った人に「この組織はどう動いてきたか」を1つの物語として説明する。

回答の必須ルール:
- 提供された「組織記憶」のみを根拠にする。記録に無い事は憶測しない
- 日本語、3〜6 段落、800 字以内
- 主要な決定 / 失敗 / 成功を、それぞれ少なくとも 1 件は触れる(該当データがある場合のみ)
- 各根拠に [#<id 先頭 8 文字>] を必ず付ける(無いと監査で落ちる)
- 記録が薄い場合は「まだ記録が少ないので、現担当者(@で誰か)に確認してください」と正直に答える
- 専門用語は1度展開してから使う(例: 「CAC(顧客獲得コスト)」)
- 直前の会話履歴がある場合は文脈を引き継ぐが、新しい質問に直接答える
- 最後に「${FOLLOW_UP_MARKER}」セクションを設け、自然な深掘り質問を 2〜3 個ぶら下げる

禁止:
- 「公式ドキュメント参照」のような中身の無い回答
- 引用 [#id] 無しの主張
- 記録に無い数値や日付の捏造
`.trim();

// ── サービス ────────────────────────────────────────────────────────────────
export interface OnboardingPersonaServiceDeps {
  /** 組織記憶（セマンティック検索 + type 別取得）の供給元。 */
  memory: InstitutionalMemoryService;
  /** LLM 統合回答（任意）。未注入時は根拠一覧のフォールバック回答。 */
  generateText?: TextGenerator;
  personaPrompt?: string;
  /** 根拠として保証する mem_type 一覧（type 別セーフティネット取得に使う）。 */
  memTypes?: readonly string[];
  searchTopK?: number;
  searchThreshold?: number;
  perTypeLimit?: number;
  maxEvidence?: number;
  answerMaxTokens?: number;
  logger?: KitLogger;
}

export class OnboardingPersonaService {
  private readonly memory: InstitutionalMemoryService;
  private readonly generateText: TextGenerator | undefined;
  private readonly personaPrompt: string;
  private readonly memTypes: readonly string[];
  private readonly searchTopK: number;
  private readonly searchThreshold: number;
  private readonly perTypeLimit: number;
  private readonly maxEvidence: number;
  private readonly answerMaxTokens: number;
  private readonly logger: KitLogger;

  constructor(deps: OnboardingPersonaServiceDeps) {
    this.memory = deps.memory;
    this.generateText = deps.generateText;
    this.personaPrompt = deps.personaPrompt ?? DEFAULT_PERSONA_PROMPT;
    this.memTypes = deps.memTypes ?? DEFAULT_MEM_TYPES;
    this.searchTopK = deps.searchTopK ?? SEARCH_TOPK;
    this.searchThreshold = deps.searchThreshold ?? SEARCH_THRESHOLD;
    this.perTypeLimit = deps.perTypeLimit ?? PER_TYPE_TIME_TOPK;
    this.maxEvidence = deps.maxEvidence ?? MAX_EVIDENCE;
    this.answerMaxTokens = deps.answerMaxTokens ?? 1_400;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /**
   * オンボーディング質問に答える。LLM 不在時も実データの根拠一覧を
   * 保った回答を返す。throw するのは入力バリデーション時のみ。
   */
  async answer(input: OnboardingAnswerInput): Promise<OnboardingAnswer> {
    this.validate(input);
    const { tenantId, question } = input;
    const history = (input.conversationHistory ?? []).slice(-MAX_HISTORY_TURNS);

    this.logger.info(
      "decision-memory.onboarding-persona",
      `answering tenant=${tenantId} q.len=${question.length} history.turns=${history.length}`,
    );

    // 1) セマンティック検索 — 最も関連性の高い根拠。
    const semantic = await this.memory.searchMemory(tenantId, question, {
      topK: this.searchTopK,
      threshold: this.searchThreshold,
    });

    // 2) mem_type 別の時系列セーフティネット — セマンティック検索がある type を
    //    取りこぼしても「主要な決定 / 失敗 / 成功」を必ず供給する。
    const perType = await Promise.all(
      this.memTypes.map((t) => this.safeGetByType(tenantId, t)),
    );

    const evidence = this.mergeEvidence([...semantic.results, ...perType.flat()]);

    const evidenceCounts: Record<string, number> = {};
    for (const t of this.memTypes) evidenceCounts[t] = 0;
    for (const r of evidence) {
      evidenceCounts[r.memType] = (evidenceCounts[r.memType] ?? 0) + 1;
    }

    if (evidence.length === 0) {
      return {
        answer:
          "まだ組織記憶に十分な記録が無いため、自信を持ってお答えできません。現担当者に直接確認してください。",
        citations: [],
        evidenceCounts,
        suggestedFollowUps: [
          "最近の主要な意思決定をログ化するには?",
          "チャットの決定事項を自動で記憶に取り込むには?",
        ],
      };
    }

    const citations = evidence.map(toCitation);

    // 3) 統合回答の生成。LLM が無い / 失敗した場合は事実のみの
    //    フォールバック要約を返す（捏造しない）。
    let answer = "";
    if (this.generateText) {
      answer = await this.safeSynthesise(question, history, evidence);
    }
    if (!answer) answer = buildFallbackAnswer(question, evidence);

    return {
      answer,
      citations,
      evidenceCounts,
      suggestedFollowUps: extractFollowUps(answer),
    };
  }

  // ── internal ──────────────────────────────────────────────────────────────
  private validate(input: OnboardingAnswerInput): void {
    const fail = (m: string) => {
      throw new DecisionMemoryValidationError(m);
    };
    if (!input.question || typeof input.question !== "string" || !input.question.trim()) {
      fail("question is required");
    }
    if (input.question.length > MAX_QUESTION_LEN) {
      fail(`question exceeds ${MAX_QUESTION_LEN} characters`);
    }
    if (input.conversationHistory && !Array.isArray(input.conversationHistory)) {
      fail("conversationHistory must be an array");
    }
    for (const turn of input.conversationHistory ?? []) {
      if (!turn || (turn.role !== "user" && turn.role !== "assistant")) {
        fail("conversationHistory turn role must be 'user' or 'assistant'");
      }
      if (typeof turn.content !== "string") {
        fail("conversationHistory turn content must be a string");
      }
    }
  }

  private async safeGetByType(tenantId: string, memType: string): Promise<MemoryItem[]> {
    try {
      return await this.memory.getMemoryByType(tenantId, memType, this.perTypeLimit);
    } catch (err) {
      this.logger.error(`decision-memory.onboarding-persona.getByType.${memType}`, err);
      return [];
    }
  }

  private mergeEvidence(rows: MemoryItem[]): MemoryItem[] {
    const seen = new Map<string, MemoryItem>();
    for (const r of rows) {
      if (!seen.has(r.id)) seen.set(r.id, r);
    }
    // セマンティックヒットが入力配列の先頭にいるので、挿入順で優先度を保つ。
    return Array.from(seen.values()).slice(0, this.maxEvidence);
  }

  private async safeSynthesise(
    question: string,
    history: OnboardingTurn[],
    evidence: MemoryItem[],
  ): Promise<string> {
    if (!this.generateText) return "";
    try {
      const userPrompt =
        `直前の会話:\n${buildHistoryBlock(history)}\n\n` +
        `質問: ${question}\n\n` +
        `組織記憶 (${this.memTypes.join(" / ")} 混在):\n` +
        buildEvidenceBlock(evidence);
      const text = await this.generateText(this.personaPrompt, userPrompt, {
        maxTokens: this.answerMaxTokens,
      });
      return text || "";
    } catch (err) {
      this.logger.error("decision-memory.onboarding-persona.synthesise", err);
      return "";
    }
  }
}

// ── 純関数（テスト対象） ────────────────────────────────────────────────────
function toCitation(row: MemoryItem): OnboardingCitation {
  return {
    ref: `#${row.id.slice(0, 8)}`,
    id: row.id,
    memType: row.memType,
    subject: row.subject,
    decidedAt: row.decidedAt,
  };
}

export function buildEvidenceBlock(rows: MemoryItem[]): string {
  return rows
    .map((r) => {
      const sim = typeof r.similarity === "number" ? ` similarity=${r.similarity.toFixed(2)}` : "";
      return (
        `[#${r.id.slice(0, 8)}] type=${r.memType} subject=${r.subject} ` +
        `decided_at=${r.decidedAt}${sim}\ncontent: ${r.content}`
      );
    })
    .join("\n---\n");
}

export function buildHistoryBlock(history: OnboardingTurn[]): string {
  if (history.length === 0) return "(なし)";
  return history.map((t) => `${t.role === "user" ? "Q" : "A"}: ${t.content}`).join("\n");
}

export function buildFallbackAnswer(question: string, evidence: MemoryItem[]): string {
  const head = `「${question}」について組織記憶から ${evidence.length} 件の関連記録が見つかりました。AI 要約は現在無効化されているため、以下を直接ご確認ください:`;
  const list = evidence
    .slice(0, 8)
    .map((r) => `- [#${r.id.slice(0, 8)}] [${r.memType}] ${r.subject} (${r.decidedAt.slice(0, 10)})`)
    .join("\n");
  return `${head}\n\n${list}\n\n${FOLLOW_UP_MARKER}\n- なぜこの判断をしたか?\n- 失敗事例から何を学んだか?`;
}

/**
 * ペルソナは末尾に「${FOLLOW_UP_MARKER}」ブロックを置くよう指示されている。
 * 箇条書きを取り出して UI のクイックリプライに使えるようにする。
 */
export function extractFollowUps(answer: string): string[] {
  const marker = answer.lastIndexOf(FOLLOW_UP_MARKER);
  if (marker < 0) return [];
  const tail = answer.slice(marker);
  const lines = tail.split("\n").map((l) => l.trim());
  const bullets = lines
    .filter((l) => l.startsWith("- ") || l.startsWith("・"))
    .map((l) => l.replace(/^[-・]\s*/, "").trim())
    .filter((l) => l.length > 0);
  return bullets.slice(0, 4);
}
