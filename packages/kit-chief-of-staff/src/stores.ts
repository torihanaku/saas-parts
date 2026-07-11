/**
 * ストレージ注入インターフェース + インメモリ実装。
 *
 * 元実装は Supabase（dd_cos_digest_items / dd_cos_extracted_tasks /
 * dd_cos_briefings / dd_cos_tenant_settings / dd_cos_email_settings）への
 * REST 呼び出し。本キットではテーブルごとの Store インターフェースに置き換え、
 * テスト・プロトタイプ用のインメモリ実装を同梱する。
 * 本番スキーマ（RLS / retention / CHECK 制約）は README の SQL を参照。
 */
import type {
  CosBriefing,
  CosBriefingType,
  CosDigestItem,
  CosEmailSettings,
  CosExtractedTask,
  CosSourceType,
  CosTenantSettings,
  StoreResult,
} from "./types";

// ─── Digest store ─────────────────────────────────────────────────────────────

export type NewDigestItem = Omit<CosDigestItem, "id" | "ingestedAt">;

export interface DigestQuery {
  sourceType?: CosSourceType;
  /** ingested_at >= sinceIso */
  sinceIso?: string;
  /** ingested_at <= untilIso */
  untilIso?: string;
  /** relevance_score >= minRelevance（null スコアは除外） */
  minRelevance?: number;
  /** "relevance" = relevance desc（feed / briefing）, "ingestedAt" = 新着順（QA） */
  orderBy?: "relevance" | "ingestedAt";
  limit?: number;
}

export interface DigestStore {
  insert(item: NewDigestItem): Promise<StoreResult>;
  query(tenantId: string, q: DigestQuery): Promise<CosDigestItem[]>;
}

// ─── Task store ───────────────────────────────────────────────────────────────

export type NewExtractedTask = Omit<
  CosExtractedTask,
  "id" | "createdAt" | "syncedTo" | "externalId"
>;

export interface TaskStatusPatch {
  status: CosExtractedTask["status"];
  syncedTo?: string;
  externalId?: string;
}

export interface TaskStore {
  insert(task: NewExtractedTask): Promise<StoreResult>;
  listPending(tenantId: string, limit?: number): Promise<CosExtractedTask[]>;
  getById(tenantId: string, id: string): Promise<CosExtractedTask | null>;
  updateStatus(tenantId: string, id: string, patch: TaskStatusPatch): Promise<boolean>;
}

// ─── Briefing store ───────────────────────────────────────────────────────────

export type NewBriefing = Omit<CosBriefing, "id" | "generatedAt" | "deliveredTo">;

export interface BriefingStore {
  insert(briefing: NewBriefing): Promise<StoreResult>;
  list(
    tenantId: string,
    opts?: { type?: CosBriefingType; limit?: number },
  ): Promise<CosBriefing[]>;
  getById(tenantId: string, id: string): Promise<CosBriefing | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

// ─── Tenant settings store ────────────────────────────────────────────────────

export interface TenantSettingsStore {
  get(tenantId: string): Promise<CosTenantSettings | null>;
  upsert(
    tenantId: string,
    ownerUserId: string,
    patch: Partial<
      Pick<
        CosTenantSettings,
        | "slackChannels"
        | "emailFilterRules"
        | "meetingSources"
        | "dailyBriefingEnabled"
        | "dailyBriefingTime"
      >
    >,
  ): Promise<CosTenantSettings | null>;
  /** ingest 完了時のウォーターマーク更新（失敗しても致命的ではない） */
  setWatermark(tenantId: string, source: CosSourceType, iso: string): Promise<void>;
  /** daily briefing が有効なテナント一覧（cron 走査用） */
  listBriefingEnabled(): Promise<CosTenantSettings[]>;
}

// ─── Email settings store ─────────────────────────────────────────────────────

export interface EmailSettingsStore {
  get(tenantId: string): Promise<CosEmailSettings | null>;
  upsert(
    tenantId: string,
    settings: Omit<CosEmailSettings, "tenantId" | "lastRunAt">,
  ): Promise<CosEmailSettings | null>;
}

// ─── In-memory 実装 ───────────────────────────────────────────────────────────

let seq = 0;
function newId(): string {
  seq += 1;
  return `cos-${seq.toString(36).padStart(8, "0")}`;
}

export class InMemoryDigestStore implements DigestStore {
  readonly items: CosDigestItem[] = [];

  async insert(item: NewDigestItem): Promise<StoreResult> {
    const id = newId();
    this.items.push({ ...item, id, ingestedAt: new Date().toISOString() });
    return { ok: true, id };
  }

  async query(tenantId: string, q: DigestQuery): Promise<CosDigestItem[]> {
    let rows = this.items.filter((i) => i.tenantId === tenantId);
    if (q.sourceType) rows = rows.filter((i) => i.sourceType === q.sourceType);
    if (q.sinceIso) rows = rows.filter((i) => i.ingestedAt >= q.sinceIso!);
    if (q.untilIso) rows = rows.filter((i) => i.ingestedAt <= q.untilIso!);
    if (q.minRelevance !== undefined) {
      rows = rows.filter(
        (i) => i.relevanceScore !== null && i.relevanceScore >= q.minRelevance!,
      );
    }
    rows = [...rows];
    if (q.orderBy === "ingestedAt") {
      rows.sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
    } else {
      // relevance desc nulls last, tie-break ingested_at desc（feed の並びと同じ）
      rows.sort((a, b) => {
        const ra = a.relevanceScore ?? -1;
        const rb = b.relevanceScore ?? -1;
        if (rb !== ra) return rb - ra;
        return b.ingestedAt.localeCompare(a.ingestedAt);
      });
    }
    return rows.slice(0, q.limit ?? 50);
  }
}

export class InMemoryTaskStore implements TaskStore {
  readonly tasks: CosExtractedTask[] = [];

  async insert(task: NewExtractedTask): Promise<StoreResult> {
    const id = newId();
    this.tasks.push({
      ...task,
      id,
      syncedTo: null,
      externalId: null,
      createdAt: new Date().toISOString(),
    });
    return { ok: true, id };
  }

  async listPending(tenantId: string, limit = 200): Promise<CosExtractedTask[]> {
    return this.tasks
      .filter((t) => t.tenantId === tenantId && t.status === "pending_review")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async getById(tenantId: string, id: string): Promise<CosExtractedTask | null> {
    return this.tasks.find((t) => t.tenantId === tenantId && t.id === id) ?? null;
  }

  async updateStatus(
    tenantId: string,
    id: string,
    patch: TaskStatusPatch,
  ): Promise<boolean> {
    const task = await this.getById(tenantId, id);
    if (!task) return false;
    task.status = patch.status;
    if (patch.syncedTo !== undefined) task.syncedTo = patch.syncedTo;
    if (patch.externalId !== undefined) task.externalId = patch.externalId;
    return true;
  }
}

export class InMemoryBriefingStore implements BriefingStore {
  readonly briefings: CosBriefing[] = [];

  async insert(briefing: NewBriefing): Promise<StoreResult> {
    const id = newId();
    this.briefings.push({
      ...briefing,
      id,
      deliveredTo: [],
      generatedAt: new Date().toISOString(),
    });
    return { ok: true, id };
  }

  async list(
    tenantId: string,
    opts: { type?: CosBriefingType; limit?: number } = {},
  ): Promise<CosBriefing[]> {
    return this.briefings
      .filter(
        (b) => b.tenantId === tenantId && (!opts.type || b.briefingType === opts.type),
      )
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
      .slice(0, Math.min(opts.limit ?? 10, 50));
  }

  async getById(tenantId: string, id: string): Promise<CosBriefing | null> {
    return (
      this.briefings.find((b) => b.tenantId === tenantId && b.id === id) ?? null
    );
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const idx = this.briefings.findIndex(
      (b) => b.tenantId === tenantId && b.id === id,
    );
    if (idx === -1) return false;
    this.briefings.splice(idx, 1);
    return true;
  }
}

export class InMemoryTenantSettingsStore implements TenantSettingsStore {
  readonly rows = new Map<string, CosTenantSettings>();

  async get(tenantId: string): Promise<CosTenantSettings | null> {
    return this.rows.get(tenantId) ?? null;
  }

  async upsert(
    tenantId: string,
    ownerUserId: string,
    patch: Partial<
      Pick<
        CosTenantSettings,
        | "slackChannels"
        | "emailFilterRules"
        | "meetingSources"
        | "dailyBriefingEnabled"
        | "dailyBriefingTime"
      >
    >,
  ): Promise<CosTenantSettings | null> {
    const now = new Date().toISOString();
    const existing = this.rows.get(tenantId);
    const next: CosTenantSettings = existing
      ? { ...existing, ...patch, updatedAt: now }
      : {
          tenantId,
          ownerUserId,
          slackChannels: patch.slackChannels ?? [],
          emailFilterRules: patch.emailFilterRules ?? [],
          meetingSources: patch.meetingSources ?? [],
          dailyBriefingEnabled: patch.dailyBriefingEnabled ?? true,
          dailyBriefingTime: patch.dailyBriefingTime ?? "08:00",
          lastSlackIngestedAt: null,
          lastEmailIngestedAt: null,
          lastMeetingIngestedAt: null,
          createdAt: now,
          updatedAt: now,
        };
    this.rows.set(tenantId, next);
    return next;
  }

  async setWatermark(
    tenantId: string,
    source: CosSourceType,
    iso: string,
  ): Promise<void> {
    const row = this.rows.get(tenantId);
    if (!row) return;
    if (source === "slack") row.lastSlackIngestedAt = iso;
    else if (source === "email") row.lastEmailIngestedAt = iso;
    else row.lastMeetingIngestedAt = iso;
    row.updatedAt = iso;
  }

  async listBriefingEnabled(): Promise<CosTenantSettings[]> {
    return [...this.rows.values()].filter((r) => r.dailyBriefingEnabled);
  }
}

export class InMemoryEmailSettingsStore implements EmailSettingsStore {
  readonly rows = new Map<string, CosEmailSettings>();

  async get(tenantId: string): Promise<CosEmailSettings | null> {
    return this.rows.get(tenantId) ?? null;
  }

  async upsert(
    tenantId: string,
    settings: Omit<CosEmailSettings, "tenantId" | "lastRunAt">,
  ): Promise<CosEmailSettings | null> {
    const existing = this.rows.get(tenantId);
    const next: CosEmailSettings = {
      ...settings,
      tenantId,
      lastRunAt: existing?.lastRunAt ?? null,
    };
    this.rows.set(tenantId, next);
    return next;
  }
}
