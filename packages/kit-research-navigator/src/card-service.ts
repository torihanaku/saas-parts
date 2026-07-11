/**
 * カードサービス — 仮説カードのライフサイクル管理。
 *
 * - 作成 (手動入力 → LLM 生成 / Stack Advisor 推薦 → 決定的組み立て)
 * - ステータス遷移 (draft → testing → validated/invalidated、遷移表で強制)
 * - アクション実行 (issue 起票 / SNS ドラフト生成 / 却下)
 * - 学び (learning) の記録
 *
 * HTTP 配線は含まない。結果は discriminated union で返す。
 *
 * 出典: dev-dashboard-v2 server/routes/navigator/{cards,hypothesis,learnings}.ts,
 *       server/lib/navigator/action-executor.ts
 */
import type {
  ActionStore,
  CardStore,
  IssueProvider,
  LearningStore,
  LlmClient,
} from "./ports";
import type {
  Card,
  CardAction,
  CardActionType,
  CardLearning,
  CardStatus,
  LearningOutcome,
} from "./types";
import {
  buildStackAdvisorCard,
  generateManualCard,
  type StackAdvisorCardInput,
} from "./card-generator";
import { generateSocialDraft } from "./action-executor";

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

export const VALID_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  draft: ["testing", "rejected"],
  testing: ["validated", "invalidated", "rejected"],
  validated: [],
  invalidated: ["draft", "rejected"],
  rejected: [],
};

const OUTCOME_MAP: Record<CardStatus, LearningOutcome> = {
  validated: "validated",
  invalidated: "invalidated",
  rejected: "neutral",
  testing: "neutral",
  draft: "neutral",
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type CardServiceError =
  | "not_found"
  | "generation_failed"
  | "invalid_transition"
  | "target_repo_required"
  | "reason_required"
  | "issue_provider_missing"
  | "issue_provider_error"
  | "llm_missing"
  | "llm_error"
  | "validation";

export type ServiceResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: CardServiceError; detail?: string };

export interface CardServiceDeps {
  cardStore: CardStore;
  actionStore: ActionStore;
  learningStore: LearningStore;
  llm?: LlmClient | null;
  issueProvider?: IssueProvider | null;
  now?: () => Date;
  onWarn?: (message: string, error?: unknown) => void;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createManualCard(
  userId: string,
  input: {
    rawInput: string;
    projectContext?: string;
    hypothesis?: string;
    assumption?: string;
    testPlan?: string;
    invalidationCriteria?: string;
  },
  deps: CardServiceDeps,
): Promise<ServiceResult<{ card: Card }>> {
  if (!deps.llm) return { ok: false, error: "llm_missing" };

  const generated = await generateManualCard(
    input.rawInput,
    input.projectContext ?? "",
    deps.llm,
    { now: deps.now, onWarn: deps.onWarn },
  );
  if (!generated) return { ok: false, error: "generation_failed" };

  const card = await deps.cardStore.insert(userId, {
    triggerSource: "manual",
    title: generated.source.title,
    summary: generated.source.summary,
    cardData: generated,
    status: "draft",
    hypothesis: input.hypothesis,
    assumption: input.assumption,
    testPlan: input.testPlan,
    invalidationCriteria: input.invalidationCriteria,
  });
  return { ok: true, card };
}

export async function createStackCard(
  userId: string,
  input: StackAdvisorCardInput,
  deps: CardServiceDeps,
): Promise<ServiceResult<{ card: Card }>> {
  const title = input.title.trim();
  const summary = input.summary.trim();
  if (!title || !summary) {
    return {
      ok: false,
      error: "validation",
      detail: "title and summary are required",
    };
  }

  const cardData = buildStackAdvisorCard(
    { ...input, title, summary },
    deps.now ?? (() => new Date()),
  );

  const card = await deps.cardStore.insert(userId, {
    triggerSource: "stack",
    triggerStackId: input.triggerStackId,
    title,
    summary,
    cardData,
    status: "draft",
    hypothesis: input.hypothesis,
    assumption: input.assumption,
    testPlan: input.testPlan,
    invalidationCriteria: input.invalidationCriteria,
  });
  return { ok: true, card };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listCards(
  userId: string,
  opts: { status?: CardStatus; limit?: number },
  deps: CardServiceDeps,
): Promise<Card[]> {
  return deps.cardStore.list(userId, opts);
}

export async function getCardDetail(
  userId: string,
  cardId: string,
  deps: CardServiceDeps,
): Promise<ServiceResult<{
  card: Card;
  actions: CardAction[];
  learnings: CardLearning[];
}>> {
  const card = await deps.cardStore.getById(userId, cardId);
  if (!card) return { ok: false, error: "not_found" };
  const actions = await deps.actionStore.listByCard(userId, cardId);
  const learnings = await deps.learningStore.listByCard(userId, cardId);
  return { ok: true, card, actions, learnings };
}

// ---------------------------------------------------------------------------
// Status transition (+ 自動 learning 記録)
// ---------------------------------------------------------------------------

export async function updateCardStatus(
  userId: string,
  cardId: string,
  nextStatus: CardStatus,
  reason: string | undefined,
  deps: CardServiceDeps,
): Promise<ServiceResult<{ card: Card }>> {
  const card = await deps.cardStore.getById(userId, cardId);
  if (!card) return { ok: false, error: "not_found" };

  if (!VALID_TRANSITIONS[card.status].includes(nextStatus)) {
    return {
      ok: false,
      error: "invalid_transition",
      detail: `${card.status} -> ${nextStatus}`,
    };
  }

  const updated = await deps.cardStore.update(userId, cardId, {
    status: nextStatus,
  });
  if (!updated) return { ok: false, error: "not_found" };

  await deps.learningStore.insert(userId, {
    cardId,
    learning: `[status change] ${card.status} -> ${nextStatus}${reason ? `: ${reason}` : ""}`,
    outcome: OUTCOME_MAP[nextStatus],
  });

  return { ok: true, card: updated };
}

// ---------------------------------------------------------------------------
// Learnings
// ---------------------------------------------------------------------------

export const LEARNING_MIN_LENGTH = 5;
export const LEARNING_MAX_LENGTH = 500;

export async function addLearning(
  userId: string,
  cardId: string,
  input: { learning: string; outcome?: LearningOutcome },
  deps: CardServiceDeps,
): Promise<ServiceResult<{ learning: CardLearning }>> {
  if (
    typeof input.learning !== "string" ||
    input.learning.length < LEARNING_MIN_LENGTH ||
    input.learning.length > LEARNING_MAX_LENGTH
  ) {
    return {
      ok: false,
      error: "validation",
      detail: `Learning text must be between ${LEARNING_MIN_LENGTH} and ${LEARNING_MAX_LENGTH} characters.`,
    };
  }

  const card = await deps.cardStore.getById(userId, cardId);
  if (!card) return { ok: false, error: "not_found" };

  const learning = await deps.learningStore.insert(userId, {
    cardId,
    learning: input.learning,
    outcome: input.outcome ?? "neutral",
  });
  return { ok: true, learning };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function executeCardAction(
  userId: string,
  cardId: string,
  input: { actionType: CardActionType; payload: Record<string, unknown> },
  deps: CardServiceDeps,
): Promise<ServiceResult<{ action: CardAction; card: Card }>> {
  const card = await deps.cardStore.getById(userId, cardId);
  if (!card) return { ok: false, error: "not_found" };

  let actionPayload: Record<string, unknown> = { ...input.payload };
  let nextStatus: CardStatus = card.status;

  if (input.actionType === "issue") {
    const targetRepo =
      (input.payload.targetRepo as string | undefined) ||
      card.cardData.output.targetRepo;
    if (!targetRepo) return { ok: false, error: "target_repo_required" };
    if (!deps.issueProvider) return { ok: false, error: "issue_provider_missing" };

    const created = await deps.issueProvider.createIssue({
      title: card.title,
      body: card.cardData.output.draftText,
      targetRepo,
    });
    if (!created) return { ok: false, error: "issue_provider_error" };

    actionPayload = { ...actionPayload, issueUrl: created.url };
    nextStatus = "testing";
  } else if (input.actionType === "social_draft") {
    if (!deps.llm) return { ok: false, error: "llm_missing" };
    const finalDraft = await generateSocialDraft(
      deps.llm,
      card.cardData.output.draftText,
      card.cardData.meta.rationale,
      { onWarn: deps.onWarn },
    );
    if (!finalDraft) return { ok: false, error: "llm_error" };

    actionPayload = { ...actionPayload, finalDraft };
    nextStatus = "testing";
  } else if (input.actionType === "reject") {
    if (!input.payload.reason) return { ok: false, error: "reason_required" };
    nextStatus = "rejected";
  }
  // "saved_for_later" は記録のみ

  let updated = card;
  if (nextStatus !== card.status) {
    const saved = await deps.cardStore.update(userId, cardId, {
      status: nextStatus,
    });
    if (saved) updated = saved;
  }

  const action = await deps.actionStore.insert(userId, {
    cardId,
    actionType: input.actionType,
    payload: actionPayload,
  });

  return { ok: true, action, card: updated };
}
