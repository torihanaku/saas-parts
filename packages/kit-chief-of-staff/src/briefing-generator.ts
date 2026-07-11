/**
 * Briefing generator（元: server/lib/cos/briefing-generator.ts, COS-5）。
 *
 * digest（Slack/Email/Meeting）＋ 承認待ちタスク ＋ 任意の追加コンテキスト
 * （元実装では今週の Agent プランと因果推論 insight）を集約して LLM に渡し、
 * daily / weekly / status_report ブリーフィングを生成・永続化する。
 *
 * 設計:
 * - daily = 直近 24h / weekly・status_report = 直近 7d
 * - key_items_json には digest 上位 5 件の ID を保存
 * - 生成失敗（LLM 未注入・空応答）でも決定的なフォールバック要約を必ず保存する
 *   （呼び出し側が silent NULL を受け取らない契約）
 *
 * 汎用化: Supabase 読みは DigestStore / TaskStore 経由に、Agent プラン・因果
 * insight は `BriefingContextProvider`（任意注入）に置き換えた。
 */
import type { CosBriefingType, LlmCaller } from "./types";
import type { BriefingStore, DigestStore, TaskStore } from "./stores";

// ─── 期間ヘルパー ─────────────────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

/** briefing type ごとの対象期間 [start, end) を計算する。 */
export function periodFor(
  type: CosBriefingType,
  now: Date = new Date(),
): { start: Date; end: Date } {
  const end = now;
  const span = type === "daily" ? ONE_DAY_MS : SEVEN_DAYS_MS;
  return { start: new Date(end.getTime() - span), end };
}

/** ISO 週文字列（例 "2026-W18"）。 */
export function isoWeek(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

// ─── 集約入力（純関数でテスト可能） ──────────────────────────────────────────

export interface BriefingDigestRow {
  id: string;
  sourceType: string;
  summary: string;
}

export interface BriefingTaskRow {
  taskText: string;
  assigneeHint: string | null;
  dueHint: string | null;
}

/** 元実装の dd_agent_plans（今週のプラン）を一般化したもの */
export interface BriefingPlanRef {
  title: string;
  status: string;
}

/** 元実装の dd_causal_results（因果推論 insight）を一般化したもの */
export interface BriefingInsight {
  label: string;
  detail: string;
}

export interface BriefingInputs {
  digests: BriefingDigestRow[];
  tasks: BriefingTaskRow[];
  plan: BriefingPlanRef | null;
  insights: BriefingInsight[];
}

/**
 * digest 以外の追加コンテキスト（プラン・分析 insight 等）の注入点。
 * 未注入時は plan=null / insights=[] として扱う。
 */
export type BriefingContextProvider = (
  tenantId: string,
  period: { start: Date; end: Date },
  weekIso: string,
) => Promise<{ plan?: BriefingPlanRef | null; insights?: BriefingInsight[] }>;

/** LLM user prompt を集約入力から構築する。純関数。 */
export function buildBriefingPrompt(
  type: CosBriefingType,
  inputs: BriefingInputs,
  askHint = "/cos/ask",
): string {
  const heading =
    type === "daily" ? "日次" : type === "weekly" ? "週次" : "上司向け状況レポート";
  const targetLen = type === "weekly" ? "600 字" : "400 字";
  const focus = type === "daily" ? "今日" : "今週";

  const digestLines = inputs.digests.length
    ? inputs.digests.map((d) => `- [${d.sourceType}] ${d.summary}`).join("\n")
    : "- なし";
  const taskLines = inputs.tasks.length
    ? inputs.tasks
        .map((t) => `- ${t.taskText} ${t.assigneeHint ?? ""} ${t.dueHint ?? ""}`.trim())
        .join("\n")
    : "- なし";
  const planLine = inputs.plan ? `${inputs.plan.title} (${inputs.plan.status})` : "プラン無し";
  const insightLines = inputs.insights.length
    ? inputs.insights.map((c) => `- ${c.label}: ${c.detail}`).join("\n")
    : "- なし";

  return `${heading}ブリーフィングを生成してください。

【Slack/Meeting/Email 要約 (${inputs.digests.length} 件)】
${digestLines}

【承認待ちタスク (${inputs.tasks.length} 件)】
${taskLines}

【今週のプラン】
${planLine}

【分析 insight】
${insightLines}

要件:
- 日本語 ${targetLen}程度
- 「${focus}の優先 3 件」「確認が必要な事項」「祝うべき成果」の 3 section
- 数字は honestly、数字が無ければ無いと明記
- 最後に「質問があれば ${askHint} で聞いてください」`;
}

/** チーフ・オブ・スタッフの役割定義（ドメインをパラメータ化） */
export function buildBriefingSystemPrompt(domainLabel: string): string {
  return `あなたは${domainLabel}領域のチーフ・オブ・スタッフです。チーム横断の動きを冷静に整理し、誇張せず行動可能なブリーフィングを日本語で出力してください。`;
}

export const DEFAULT_BRIEFING_DOMAIN = "マーケティング/PR";

/** key_items_json 用の上位 N digest ID。 */
export function pickKeyItemIds(digests: BriefingDigestRow[], n = 5): string[] {
  return digests.slice(0, n).map((d) => d.id);
}

/** LLM キー未設定・生成失敗時の決定的なフォールバック。 */
export function fallbackSummary(
  type: CosBriefingType,
  inputs: BriefingInputs,
  detailHint = "/cos",
): string {
  const label =
    type === "daily" ? "日次" : type === "weekly" ? "週次" : "ステータスレポート";
  return [
    `[${label}ブリーフィング — AI 要約は利用できませんでした]`,
    `集計: digest ${inputs.digests.length} 件 / 承認待ちタスク ${inputs.tasks.length} 件 / insight ${inputs.insights.length} 件。`,
    `プラン: ${inputs.plan ? `${inputs.plan.title} (${inputs.plan.status})` : "なし"}。`,
    `詳細は ${detailHint} でご確認ください。`,
  ].join("\n");
}

// ─── ジェネレータ ─────────────────────────────────────────────────────────────

export interface GeneratedBriefing {
  id: string;
  tenantId: string;
  type: CosBriefingType;
  summary: string;
  keyItemIds: string[];
  periodStart: string;
  periodEnd: string;
}

export interface BriefingGeneratorDeps {
  digestStore: DigestStore;
  taskStore: TaskStore;
  briefingStore: BriefingStore;
  /** 未注入時はフォールバック要約が保存される */
  llm?: LlmCaller;
  contextProvider?: BriefingContextProvider;
  /** 「質問があれば◯◯で」の誘導先（プロダクトの Q&A パス等） */
  askHint?: string;
  /** フォールバック文の詳細誘導先 */
  detailHint?: string;
  /** システムプロンプトのドメインラベル */
  domainLabel?: string;
}

export class BriefingGenerator {
  private readonly deps: BriefingGeneratorDeps;
  private readonly systemPrompt: string;

  constructor(deps: BriefingGeneratorDeps) {
    this.deps = deps;
    this.systemPrompt = buildBriefingSystemPrompt(
      deps.domainLabel ?? DEFAULT_BRIEFING_DOMAIN,
    );
  }

  private async fetchInputs(
    tenantId: string,
    period: { start: Date; end: Date },
    weekIso: string,
  ): Promise<BriefingInputs> {
    const [digests, tasks, extra] = await Promise.all([
      this.deps.digestStore.query(tenantId, {
        sinceIso: period.start.toISOString(),
        orderBy: "relevance",
        limit: 20,
      }),
      this.deps.taskStore.listPending(tenantId, 10),
      this.deps.contextProvider
        ? this.deps.contextProvider(tenantId, period, weekIso)
        : Promise.resolve({ plan: null, insights: [] }),
    ]);

    return {
      digests: digests.map((d) => ({
        id: d.id,
        sourceType: d.sourceType,
        summary: d.summary,
      })),
      tasks: tasks.map((t) => ({
        taskText: t.taskText,
        assigneeHint: t.assigneeHint,
        dueHint: t.dueHint,
      })),
      plan: extra.plan ?? null,
      insights: extra.insights ?? [],
    };
  }

  /**
   * ブリーフィングを生成して永続化する。
   * 常に行を insert する — LLM が "" を返しても決定的フォールバックを保存。
   */
  async generate(
    tenantId: string,
    type: CosBriefingType,
    now: Date = new Date(),
  ): Promise<GeneratedBriefing> {
    const period = periodFor(type, now);
    const inputs = await this.fetchInputs(tenantId, period, isoWeek(now));

    const prompt = buildBriefingPrompt(type, inputs, this.deps.askHint);

    let summary = "";
    if (this.deps.llm) {
      summary = await this.deps.llm.generateText(this.systemPrompt, prompt, {
        maxTokens: 1200,
      });
    }
    if (!summary) {
      summary = fallbackSummary(type, inputs, this.deps.detailHint);
    }

    const keyItemIds = pickKeyItemIds(inputs.digests);
    const inserted = await this.deps.briefingStore.insert({
      tenantId,
      briefingType: type,
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      summaryText: summary,
      keyItemsJson: keyItemIds,
    });

    if (!inserted.ok) {
      throw new Error(`briefing insert failed: ${inserted.error}`);
    }

    return {
      id: inserted.id,
      tenantId,
      type,
      summary,
      keyItemIds,
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
    };
  }
}
