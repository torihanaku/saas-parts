/**
 * handoff.ts — 担当者交代向け「案件の全経緯」引き継ぎパッケージ生成（MEM-7）。
 *
 * 出典: dev-dashboard-v2 server/lib/institutional-memory/handoff-summarizer.ts
 * + handoff-markdown.ts。
 * 案件（caseId = MemoryItem.source）に紐づく記録を mem_type 別にバケットし、
 * 主要連絡先（decidedBy）を抽出、LLM で 600 字のナラティブを生成して
 * Markdown に組み立てる。Slack 配信（handoff-slack.ts）は落とした。
 * Supabase → MemoryStore、Claude → TextGenerator、生成日時 → ServiceContext。
 */

import type { MemoryStore } from "./stores.js";
import {
  DecisionMemoryValidationError,
  NOOP_LOGGER,
  resolveContext,
  type KitLogger,
  type MemoryItem,
  type ServiceContext,
  type TextGenerator,
} from "./types.js";

// ── 定数（本家と同値） ──────────────────────────────────────────────────────
const DEFAULT_PER_CATEGORY_LIMIT = 25;
const MAX_PER_CATEGORY_LIMIT = 100;

export const DEFAULT_MEM_TYPE_LABELS_JA: Record<string, string> = {
  decision_log: "決定事項",
  failure_recipe: "失敗 / 注意点",
  success_recipe: "成功 / 効いた施策",
};

const DEFAULT_SYSTEM_PROMPT = `
あなたは組織の引き継ぎドキュメント作成者です。
担当者交代に向けて、過去の意思決定 / 失敗事例 / 成功レシピ から「この案件の全経緯」を Markdown で要約してください。

ルール:
- 提供された記録のみを根拠にする。憶測禁止
- 出力は Markdown。 H2 セクションで「決定事項」「失敗 / 注意点」「成功 / 効いた施策」「主要連絡先」「次担当者へのアドバイス」を必ず含める
- 各事実には [#<id の先頭 8 文字>] を必ず付ける
- 600 字程度。 過剰な前置き禁止
- 記録が薄いセクションは「該当する記録なし」と明記する
`.trim();

// ── 型 ──────────────────────────────────────────────────────────────────────
export interface HandoffCitation {
  /** id の先頭 8 文字。 */
  id: string;
  memType: string;
  subject: string;
  decidedAt: string;
  decidedBy: string | null;
}

export interface BuildSummaryInput {
  tenantId: string;
  /** MemoryItem.source と突き合わせる案件 ID。 */
  caseId: string;
  fromUser: string;
  toUser?: string | null;
  options?: { perCategoryLimit?: number };
}

export interface BuildSummaryResult {
  markdown: string;
  citations: HandoffCitation[];
  /** 1 件でも記録が見つかったときのみ true。 */
  hasEvidence: boolean;
}

// ── Markdown レンダラー（純関数） ──────────────────────────────────────────
export interface RenderHeaderInput {
  caseId: string;
  fromUser: string;
  toUser: string | null;
  /** ISO-8601。テスト決定性のため注入。 */
  generatedAt: string;
}

export function renderHeader(input: RenderHeaderInput): string {
  return [
    `# 引き継ぎサマリ — ${input.caseId}`,
    ``,
    `- **引き継ぎ元**: ${input.fromUser}`,
    `- **引き継ぎ先**: ${input.toUser ?? "未確定"}`,
    `- **生成日時**: ${input.generatedAt}`,
  ].join("\n");
}

export function renderSummarySection(aiBody: string): string {
  if (aiBody) return `## AI による要約\n${aiBody}`;
  return [
    "## AI による要約",
    "_AI 要約は利用できません (TextGenerator 未設定 or 失敗)。下記の生データを参照してください。_",
  ].join("\n");
}

export function renderEvidenceTable(
  evidence: Record<string, MemoryItem[]>,
  labels: Record<string, string> = DEFAULT_MEM_TYPE_LABELS_JA,
): string {
  const sections: string[] = ["## 根拠データ"];
  for (const memType of Object.keys(evidence)) {
    const items = evidence[memType] ?? [];
    sections.push(`\n### ${labels[memType] ?? memType}`);
    if (items.length === 0) {
      sections.push("- （該当する記録なし）");
      continue;
    }
    for (const r of items) {
      sections.push(
        `- \`[#${r.id.slice(0, 8)}]\` **${r.subject}** (${r.decidedAt}) — ${truncate(r.content, 200)}`,
      );
    }
  }
  return sections.join("\n");
}

export function renderContacts(contacts: string[]): string {
  if (contacts.length === 0) {
    return "## 主要連絡先\n- （記録なし）";
  }
  return ["## 主要連絡先", ...contacts.map((c) => `- ${c}`)].join("\n");
}

export function renderEmptyMarkdown(input: RenderHeaderInput): string {
  return [
    renderHeader(input),
    "",
    `## AI による要約`,
    `_この案件 (${input.caseId}) に紐づく記録がありません。手動でヒアリングしてください。_`,
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── サービス ────────────────────────────────────────────────────────────────
export interface HandoffServiceDeps {
  store: MemoryStore;
  /** LLM ナラティブ生成（任意）。未注入 / 失敗時は骨格 Markdown に degrade。 */
  generateText?: TextGenerator;
  systemPrompt?: string;
  summaryMaxTokens?: number;
  /** バケットする mem_type の順序。デフォルト: decision_log / failure_recipe / success_recipe。 */
  memTypes?: readonly string[];
  /** mem_type → 見出しラベル。 */
  labels?: Record<string, string>;
  logger?: KitLogger;
  context?: ServiceContext;
}

export class HandoffService {
  private readonly store: MemoryStore;
  private readonly generateText: TextGenerator | undefined;
  private readonly systemPrompt: string;
  private readonly summaryMaxTokens: number;
  private readonly memTypes: readonly string[];
  private readonly labels: Record<string, string>;
  private readonly logger: KitLogger;
  private readonly now: () => Date;

  constructor(deps: HandoffServiceDeps) {
    this.store = deps.store;
    this.generateText = deps.generateText;
    this.systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.summaryMaxTokens = deps.summaryMaxTokens ?? 1200;
    this.memTypes = deps.memTypes ?? ["decision_log", "failure_recipe", "success_recipe"];
    this.labels = deps.labels ?? DEFAULT_MEM_TYPE_LABELS_JA;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.now = resolveContext(deps.context).now;
  }

  /**
   * 案件の記録を集めて AI 要約付きの引き継ぎ Markdown を組み立てる。
   * バリデーションエラーは throw、LLM 失敗は骨格 Markdown に degrade。
   */
  async buildHandoffSummary(input: BuildSummaryInput): Promise<BuildSummaryResult> {
    if (!input.tenantId) throw new DecisionMemoryValidationError("tenantId is required");
    if (!input.caseId || !input.caseId.trim()) {
      throw new DecisionMemoryValidationError("caseId is required");
    }
    if (!input.fromUser || !input.fromUser.trim()) {
      throw new DecisionMemoryValidationError("fromUser is required");
    }

    const limit = clampLimit(input.options?.perCategoryLimit);
    const caseId = input.caseId.trim();
    const toUser = input.toUser ?? null;
    const generatedAt = this.now().toISOString();
    const header: RenderHeaderInput = { caseId, fromUser: input.fromUser, toUser, generatedAt };

    const rows = await this.fetchCaseRows(input.tenantId, caseId, limit);
    if (rows.length === 0) {
      return {
        markdown: renderEmptyMarkdown(header),
        citations: [],
        hasEvidence: false,
      };
    }

    const citations = rows.map(toCitation);
    const evidence = this.bucketRows(rows);
    const contacts = extractContacts(rows);

    const aiBody = this.generateText
      ? await this.safeGenerate(buildUserPrompt({ caseId, fromUser: input.fromUser, toUser }, evidence, contacts, this.labels))
      : "";

    const markdown = [
      renderHeader(header),
      "",
      renderSummarySection(aiBody),
      "",
      renderEvidenceTable(evidence, this.labels),
      "",
      renderContacts(contacts),
    ].join("\n");

    this.logger.info(
      "decision-memory.handoff.buildSummary",
      `case=${caseId} rows=${rows.length} ai=${aiBody ? "yes" : "no"}`,
    );

    return { markdown, citations, hasEvidence: true };
  }

  // ── internal ──────────────────────────────────────────────────────────────
  /**
   * 案件行の取得。本家は `source = caseId` の単一クエリ + JS バケットだった。
   * キットでは listByTenant を source で絞り込む（総数は 3 × limit で上限）。
   */
  private async fetchCaseRows(
    tenantId: string,
    caseId: string,
    perCategoryLimit: number,
  ): Promise<MemoryItem[]> {
    const all = await this.store.listByTenant(tenantId);
    return all.filter((r) => r.source === caseId).slice(0, perCategoryLimit * 3);
  }

  private bucketRows(rows: MemoryItem[]): Record<string, MemoryItem[]> {
    const buckets: Record<string, MemoryItem[]> = {};
    for (const t of this.memTypes) buckets[t] = [];
    for (const r of rows) {
      (buckets[r.memType] ??= []).push(r);
    }
    return buckets;
  }

  private async safeGenerate(userPrompt: string): Promise<string> {
    if (!this.generateText) return "";
    try {
      const text = await this.generateText(this.systemPrompt, userPrompt, {
        maxTokens: this.summaryMaxTokens,
      });
      return text || "";
    } catch (err) {
      this.logger.error("decision-memory.handoff.generate", err);
      return "";
    }
  }
}

// ── ヘルパー ────────────────────────────────────────────────────────────────
function clampLimit(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    return DEFAULT_PER_CATEGORY_LIMIT;
  }
  return Math.min(Math.floor(n), MAX_PER_CATEGORY_LIMIT);
}

export function extractContacts(rows: MemoryItem[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const c = (r.decidedBy ?? "").trim();
    if (c) seen.add(c);
  }
  return Array.from(seen);
}

function toCitation(r: MemoryItem): HandoffCitation {
  return {
    id: r.id.slice(0, 8),
    memType: r.memType,
    subject: r.subject,
    decidedAt: r.decidedAt,
    decidedBy: r.decidedBy,
  };
}

function buildUserPrompt(
  header: { caseId: string; fromUser: string; toUser: string | null },
  evidence: Record<string, MemoryItem[]>,
  contacts: string[],
  labels: Record<string, string>,
): string {
  const formatBucket = (memType: string, items: MemoryItem[]) =>
    items.length === 0
      ? `## ${labels[memType] ?? memType}\n（記録なし）`
      : `## ${labels[memType] ?? memType}\n` +
        items
          .map((r) => `- [#${r.id.slice(0, 8)}] (${r.decidedAt}) ${r.subject}\n  ${r.content}`)
          .join("\n");

  return [
    `案件 (caseId): ${header.caseId}`,
    `引き継ぎ元: ${header.fromUser}`,
    header.toUser ? `引き継ぎ先: ${header.toUser}` : "引き継ぎ先: 未確定",
    "",
    ...Object.entries(evidence).flatMap(([t, items]) => [formatBucket(t, items), ""]),
    "## 関係者",
    contacts.length === 0 ? "（記録なし）" : contacts.map((c) => `- ${c}`).join("\n"),
  ].join("\n");
}
