/**
 * decision-service.ts — 意思決定レコードのライフサイクル
 * （作成 / 更新 / 削除 / 抽出候補の confirm・reject リンク）。
 *
 * 出典: 実運用SaaS server/routes/decisions/{crud.ts,index.ts}。
 * HTTP 層（Express / fetch Response）と Supabase を剥がし、
 * decision カテゴリと「登録後フック」（本家では bias-detection キュー投入）を
 * パラメータ化した。
 */

import type { DecisionStore, PendingDecisionStore } from "./stores.js";
import {
  DEFAULT_DECISION_TYPES,
  DecisionMemoryValidationError,
  NOOP_LOGGER,
  NotFoundError,
  resolveContext,
  type ConfirmPendingOverrides,
  type CreateDecisionInput,
  type DecisionRecord,
  type Embedder,
  type KitLogger,
  type PendingDecision,
  type ServiceContext,
  type UpdateDecisionInput,
} from "./types.js";

export interface DecisionLogServiceDeps {
  store: DecisionStore;
  /** 抽出候補（confirm/reject）を使う場合のみ必要。 */
  pendingStore?: PendingDecisionStore;
  /** 保存・更新時に埋め込みを再計算する（任意）。 */
  embedder?: Embedder;
  /** 許可する decision カテゴリ。デフォルト: start/stop/change/pivot/archive。 */
  decisionTypes?: readonly string[];
  /**
   * 登録・confirm 後に発火するフック（本家: バイアス検知キュー投入）。
   * 失敗しても本処理には影響しない。
   */
  onDecisionRecorded?: (decision: DecisionRecord) => void | Promise<void>;
  logger?: KitLogger;
  context?: ServiceContext;
}

export interface StagePendingInput {
  sourceRef: string;
  rawText: string;
  channel?: string | null;
  extractedSubject?: string | null;
  extractedReason?: string | null;
  extractedType?: string | null;
  confidence?: number | null;
}

export class DecisionLogService {
  private readonly store: DecisionStore;
  private readonly pendingStore: PendingDecisionStore | undefined;
  private readonly embedder: Embedder | undefined;
  private readonly decisionTypes: readonly string[];
  private readonly onDecisionRecorded:
    | ((decision: DecisionRecord) => void | Promise<void>)
    | undefined;
  private readonly logger: KitLogger;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(deps: DecisionLogServiceDeps) {
    this.store = deps.store;
    this.pendingStore = deps.pendingStore;
    this.embedder = deps.embedder;
    this.decisionTypes = deps.decisionTypes ?? DEFAULT_DECISION_TYPES;
    this.onDecisionRecorded = deps.onDecisionRecorded;
    this.logger = deps.logger ?? NOOP_LOGGER;
    const ctx = resolveContext(deps.context);
    this.now = ctx.now;
    this.generateId = ctx.generateId;
  }

  isDecisionType(value: unknown): value is string {
    return typeof value === "string" && this.decisionTypes.includes(value);
  }

  // ── create ────────────────────────────────────────────────────────────────
  async create(tenantId: string, input: CreateDecisionInput): Promise<DecisionRecord> {
    if (!input.decisionType || !input.subject || !input.reason) {
      throw new DecisionMemoryValidationError("decisionType, subject, reason required");
    }
    if (!this.isDecisionType(input.decisionType)) {
      throw new DecisionMemoryValidationError(
        `decisionType must be one of: ${this.decisionTypes.join(", ")}`,
      );
    }

    const embedding = await this.embedText(
      `${input.subject}\n${input.context ?? ""}\n${input.reason}`,
    );
    const nowIso = this.now().toISOString();
    const record: DecisionRecord = {
      id: this.generateId(),
      tenantId,
      decisionType: input.decisionType,
      subject: input.subject,
      context: input.context ?? "",
      reason: input.reason,
      alternativesConsidered: input.alternativesConsidered ?? null,
      decidedBy: input.decidedBy ?? null,
      decidedAt: input.decidedAt ?? nowIso,
      source: input.source ?? "manual",
      sourceRef: input.sourceRef ?? null,
      createdAt: nowIso,
      updatedAt: null,
    };
    await this.store.insert(record, embedding);
    this.fireRecordedHook(record);
    return record;
  }

  // ── read ──────────────────────────────────────────────────────────────────
  async list(tenantId: string): Promise<DecisionRecord[]> {
    return this.store.list(tenantId);
  }

  async get(tenantId: string, id: string): Promise<DecisionRecord | null> {
    return this.store.getById(tenantId, id);
  }

  // ── update ────────────────────────────────────────────────────────────────
  /**
   * 部分更新。subject / context / reason のいずれかが変わる場合のみ
   * 埋め込みを再計算する（本家 PATCH /api/decisions/:id と同じ規約）。
   */
  async update(
    tenantId: string,
    id: string,
    input: UpdateDecisionInput,
  ): Promise<DecisionRecord> {
    if (input.decisionType !== undefined && !this.isDecisionType(input.decisionType)) {
      throw new DecisionMemoryValidationError(
        `decisionType must be one of: ${this.decisionTypes.join(", ")}`,
      );
    }

    const existing = await this.store.getById(tenantId, id);
    if (!existing) throw new NotFoundError("Decision not found");

    let embedding: number[] | null | undefined;
    const coreChanged = Boolean(input.subject) || input.context !== undefined || Boolean(input.reason);
    if (coreChanged) {
      const newSubject = input.subject ?? existing.subject;
      const newContext = input.context !== undefined ? input.context : existing.context;
      const newReason = input.reason ?? existing.reason;
      embedding = await this.embedText(`${newSubject}\n${newContext ?? ""}\n${newReason}`);
    }

    const patch: Partial<DecisionRecord> = { updatedAt: this.now().toISOString() };
    if (input.decisionType) patch.decisionType = input.decisionType;
    if (input.subject) patch.subject = input.subject;
    if (input.context !== undefined) patch.context = input.context ?? "";
    if (input.reason) patch.reason = input.reason;
    if (input.alternativesConsidered !== undefined) {
      patch.alternativesConsidered = input.alternativesConsidered;
    }
    if (input.decidedAt) patch.decidedAt = input.decidedAt;

    const updated = await this.store.update(tenantId, id, patch, embedding);
    if (!updated) throw new NotFoundError("Decision not found");
    return updated;
  }

  // ── delete ────────────────────────────────────────────────────────────────
  /** 物理削除（本家スキーマにソフトデリート列がないため同じ挙動）。 */
  async delete(tenantId: string, id: string): Promise<void> {
    const ok = await this.store.delete(tenantId, id);
    if (!ok) throw new NotFoundError("Decision not found");
  }

  // ── 抽出候補（ステージング → リンク） ────────────────────────────────────
  /** 抽出候補を登録する（本家: Slack 抽出パイプラインが書き込む行）。 */
  async stagePending(tenantId: string, input: StagePendingInput): Promise<PendingDecision> {
    const pendingStore = this.requirePendingStore();
    const pending: PendingDecision = {
      id: this.generateId(),
      tenantId,
      sourceRef: input.sourceRef,
      channel: input.channel ?? null,
      rawText: input.rawText,
      extractedSubject: input.extractedSubject ?? null,
      extractedReason: input.extractedReason ?? null,
      extractedType: input.extractedType ?? null,
      confidence: input.confidence ?? null,
      status: "pending",
      confirmedDecisionId: null,
      extractedAt: this.now().toISOString(),
      reviewedAt: null,
      reviewedBy: null,
    };
    await pendingStore.insert(pending);
    return pending;
  }

  async listPending(tenantId: string): Promise<PendingDecision[]> {
    return this.requirePendingStore().listPending(tenantId);
  }

  /**
   * 抽出候補を承認して正式な意思決定レコードを作成し、双方向にリンクする
   * （pending.confirmedDecisionId ← decision.id / decision.sourceRef ← pending.sourceRef）。
   */
  async confirmPending(
    tenantId: string,
    pendingId: string,
    options: { overrides?: ConfirmPendingOverrides; reviewedBy?: string | null; decidedBy?: string | null } = {},
  ): Promise<{ pending: PendingDecision; decision: DecisionRecord }> {
    const pendingStore = this.requirePendingStore();
    const pending = await pendingStore.getById(tenantId, pendingId);
    if (!pending || pending.status !== "pending") {
      throw new NotFoundError("Pending decision not found");
    }

    const overrides = options.overrides ?? {};
    const fallbackType = this.decisionTypes[0] ?? "start";
    const finalType = overrides.decisionType || pending.extractedType || fallbackType;
    const finalSubject = overrides.subject || pending.extractedSubject || "Unknown Subject";
    const finalReason = overrides.reason || pending.extractedReason || "Unknown Reason";
    if (!this.isDecisionType(finalType)) {
      throw new DecisionMemoryValidationError(
        `decisionType must be one of: ${this.decisionTypes.join(", ")}`,
      );
    }

    const embedding = await this.embedText(`${finalSubject}\n\n${finalReason}`);
    const nowIso = this.now().toISOString();
    const decision: DecisionRecord = {
      id: this.generateId(),
      tenantId,
      decisionType: finalType,
      subject: finalSubject,
      context: pending.rawText,
      reason: finalReason,
      alternativesConsidered: null,
      decidedBy: options.decidedBy ?? null,
      decidedAt: nowIso,
      source: "extracted",
      sourceRef: pending.sourceRef,
      createdAt: nowIso,
      updatedAt: null,
    };
    await this.store.insert(decision, embedding);

    const updatedPending = await pendingStore.update(tenantId, pendingId, {
      status: "confirmed",
      confirmedDecisionId: decision.id,
      reviewedAt: nowIso,
      reviewedBy: options.reviewedBy ?? null,
    });
    if (!updatedPending) throw new NotFoundError("Pending decision not found");

    this.logger.info("decision-memory.decisions", `confirmed: decision_id=${decision.id}`);
    this.fireRecordedHook(decision);
    return { pending: updatedPending, decision };
  }

  /** 抽出候補を却下する。 */
  async rejectPending(
    tenantId: string,
    pendingId: string,
    options: { reviewedBy?: string | null } = {},
  ): Promise<PendingDecision> {
    const pendingStore = this.requirePendingStore();
    const pending = await pendingStore.getById(tenantId, pendingId);
    if (!pending || pending.status !== "pending") {
      throw new NotFoundError("Pending decision not found");
    }
    const updated = await pendingStore.update(tenantId, pendingId, {
      status: "rejected",
      reviewedAt: this.now().toISOString(),
      reviewedBy: options.reviewedBy ?? null,
    });
    if (!updated) throw new NotFoundError("Pending decision not found");
    this.logger.info("decision-memory.decisions", `rejected: pending_id=${pendingId}`);
    return updated;
  }

  // ── internal ──────────────────────────────────────────────────────────────
  private requirePendingStore(): PendingDecisionStore {
    if (!this.pendingStore) {
      throw new DecisionMemoryValidationError(
        "pendingStore is not configured (pass deps.pendingStore to use staged decisions)",
      );
    }
    return this.pendingStore;
  }

  private async embedText(text: string): Promise<number[] | null> {
    if (!this.embedder) return null;
    return this.embedder.embed(text);
  }

  private fireRecordedHook(decision: DecisionRecord): void {
    if (!this.onDecisionRecorded) return;
    try {
      void Promise.resolve(this.onDecisionRecorded(decision)).catch((err) => {
        this.logger.error("decision-memory.onDecisionRecorded", err);
      });
    } catch (err) {
      this.logger.error("decision-memory.onDecisionRecorded", err);
    }
  }
}
