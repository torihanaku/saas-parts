/**
 * onboarding.ts — 新任者向けオンボーディング説明（プレイブック）生成。
 *
 * 出典: dev-dashboard-v2 server/lib/institutional-memory/onboarding-service.ts
 * + server/routes/decisions/onboarding.ts。
 * 本家の buildCompositeContext（過去コンテンツ/キャンペーン合流）は
 * `contextProvider` コールバックとして注入化。マーケ固有のチャネル辞書は
 * `channelKeywords` オプションでパラメータ化した（デフォルトは空）。
 */

import type { DecisionStore } from "./stores.js";
import {
  DecisionMemoryValidationError,
  NOOP_LOGGER,
  type KitLogger,
  type OnboardingResult,
  type TextGenerator,
} from "./types.js";

const DEFAULT_SYSTEM_PROMPT = `
新しくチームに参加したメンバー向けに、過去の意思決定ログから「この組織の方針」を説明してください。
- 日本語、400 字程度
- 主要な決定 3-5 件を背景として言及
- 仮定や想像を交えない、記録されている事実のみ
- 記録が少ない場合は「まだ蓄積が少ないので、現担当者に確認してください」と正直に伝える
`.trim();

export interface OnboardingServiceDeps {
  store: DecisionStore;
  /** LLM 要約（任意）。未注入時は fallback メッセージ。 */
  generateText?: TextGenerator;
  systemPrompt?: string;
  summaryMaxTokens?: number;
  /** 直近何件の意思決定を素材にするか。デフォルト 20。 */
  recentLimit?: number;
  /** keyDecisions として返す件数。デフォルト 5。 */
  keyDecisionLimit?: number;
  /** subject / context から抽出する「既知チャネル」辞書（製品固有のため注入）。 */
  channelKeywords?: readonly string[];
  /** 追加コンテキストの合流点（本家: buildCompositeContext）。失敗しても続行。 */
  contextProvider?: (tenantId: string) => Promise<string>;
  emptyMessage?: string;
  noLlmMessage?: string;
  logger?: KitLogger;
}

export interface OnboardingInput {
  tenantId: string;
  topic: string;
}

export class OnboardingService {
  private readonly store: DecisionStore;
  private readonly generateText: TextGenerator | undefined;
  private readonly systemPrompt: string;
  private readonly summaryMaxTokens: number;
  private readonly recentLimit: number;
  private readonly keyDecisionLimit: number;
  private readonly channelKeywords: readonly string[];
  private readonly contextProvider: ((tenantId: string) => Promise<string>) | undefined;
  private readonly emptyMessage: string;
  private readonly noLlmMessage: string;
  private readonly logger: KitLogger;

  constructor(deps: OnboardingServiceDeps) {
    this.store = deps.store;
    this.generateText = deps.generateText;
    this.systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.summaryMaxTokens = deps.summaryMaxTokens ?? 800;
    this.recentLimit = deps.recentLimit ?? 20;
    this.keyDecisionLimit = deps.keyDecisionLimit ?? 5;
    this.channelKeywords = deps.channelKeywords ?? [];
    this.contextProvider = deps.contextProvider;
    this.emptyMessage =
      deps.emptyMessage ??
      "意思決定の記録がまだありません。現担当者に直接お尋ねください。";
    this.noLlmMessage =
      deps.noLlmMessage ??
      "AI 要約機能を実行できません（TextGenerator 未設定）。主要な決定一覧をご確認ください。";
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  async explainTopic(input: OnboardingInput): Promise<OnboardingResult> {
    if (!input.topic || !input.topic.trim()) {
      throw new DecisionMemoryValidationError("topic is required");
    }
    this.logger.info(
      "decision-memory.onboarding",
      `explaining topic: "${input.topic}" for tenant=${input.tenantId}`,
    );

    // 1. 直近の意思決定を時系列で取得（embedding 類似ではない）
    const recent = (await this.store.list(input.tenantId)).slice(0, this.recentLimit);
    if (recent.length === 0) {
      return {
        summary: this.emptyMessage,
        keyDecisions: [],
        knownChannels: [],
        recommendedReading: [],
      };
    }

    // 2. 追加コンテキストの合流（失敗しても degrade して続行）
    let compositeContext = "";
    if (this.contextProvider) {
      try {
        compositeContext = await this.contextProvider(input.tenantId);
      } catch (err) {
        this.logger.error("decision-memory.onboarding.contextProvider", err);
        compositeContext = "（コンテキスト情報の取得に失敗しました）";
      }
    }

    // 3. LLM 要約（任意注入）
    let summary = this.noLlmMessage;
    if (this.generateText) {
      const recentText = recent
        .map((r) => `- [${r.decisionType}] ${r.subject}: ${r.reason}`)
        .join("\n");
      const userPrompt =
        `トピック: ${input.topic}\n\n最近の意思決定:\n${recentText}` +
        (compositeContext ? `\n\n組織コンテキスト:\n${compositeContext}` : "");
      summary =
        (await this.generateText(this.systemPrompt, userPrompt, {
          maxTokens: this.summaryMaxTokens,
        })) || "回答を生成できませんでした。";
    }

    // 4. keyDecisions: 直近から数件抜粋
    const keyDecisions = recent.slice(0, this.keyDecisionLimit).map((r) => ({
      id: r.id,
      subject: r.subject,
      reason: r.reason,
    }));

    // 5. knownChannels: 注入されたキーワード辞書で抽出（簡易）
    const known = new Set<string>();
    for (const r of recent) {
      for (const k of this.channelKeywords) {
        if (r.subject.includes(k) || (r.context && r.context.includes(k))) {
          known.add(k);
        }
      }
    }

    return {
      summary,
      keyDecisions,
      knownChannels: Array.from(known),
      recommendedReading: [],
    };
  }
}
