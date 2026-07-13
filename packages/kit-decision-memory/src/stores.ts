/**
 * stores.ts — 永続化の注入インターフェース + インメモリ実装。
 *
 * 本家（実運用SaaS）は Supabase(Postgres + pgvector) 直結だったが、
 * キットではストレージをインターフェースとして注入する。
 * SQL スキーマは README の「SQLスキーマ」参照。
 */

import type { DecisionRecord, MemoryItem, PendingDecision } from "./types.js";

// ── ナレッジ（dd_institutional_memory 相当） ────────────────────────────────
export interface MemoryStore {
  insert(item: MemoryItem, embedding?: number[] | null): Promise<void>;
  /** decidedAt 降順。 */
  listByTenant(tenantId: string): Promise<MemoryItem[]>;
  /** decidedAt 降順・limit 件。 */
  listByType(tenantId: string, memType: string, limit: number): Promise<MemoryItem[]>;
  getById(tenantId: string, id: string): Promise<MemoryItem | null>;
}

// ── 意思決定ログ（dd_decision_log 相当） ────────────────────────────────────
export interface DecisionStore {
  insert(record: DecisionRecord, embedding?: number[] | null): Promise<void>;
  /** decidedAt 降順。 */
  list(tenantId: string): Promise<DecisionRecord[]>;
  getById(tenantId: string, id: string): Promise<DecisionRecord | null>;
  /** 見つからなければ null。embedding は undefined なら据え置き。 */
  update(
    tenantId: string,
    id: string,
    patch: Partial<DecisionRecord>,
    embedding?: number[] | null,
  ): Promise<DecisionRecord | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

// ── 抽出候補（dd_slack_extracted_decisions 相当・汎用化） ───────────────────
export interface PendingDecisionStore {
  insert(pending: PendingDecision): Promise<void>;
  /** status=pending を extractedAt 降順で。 */
  listPending(tenantId: string): Promise<PendingDecision[]>;
  getById(tenantId: string, id: string): Promise<PendingDecision | null>;
  update(
    tenantId: string,
    id: string,
    patch: Partial<PendingDecision>,
  ): Promise<PendingDecision | null>;
}

// ── インメモリ実装 ──────────────────────────────────────────────────────────
function byDecidedAtDesc(a: { decidedAt: string }, z: { decidedAt: string }): number {
  return z.decidedAt.localeCompare(a.decidedAt);
}

export class InMemoryMemoryStore implements MemoryStore {
  private items = new Map<string, MemoryItem>();
  /** テスト・デバッグ用に embedding も保持する。 */
  readonly embeddings = new Map<string, number[] | null>();

  async insert(item: MemoryItem, embedding?: number[] | null): Promise<void> {
    this.items.set(item.id, { ...item });
    this.embeddings.set(item.id, embedding ?? null);
  }

  async listByTenant(tenantId: string): Promise<MemoryItem[]> {
    return [...this.items.values()]
      .filter((i) => i.tenantId === tenantId)
      .sort(byDecidedAtDesc)
      .map((i) => ({ ...i }));
  }

  async listByType(tenantId: string, memType: string, limit: number): Promise<MemoryItem[]> {
    return (await this.listByTenant(tenantId))
      .filter((i) => i.memType === memType)
      .slice(0, limit);
  }

  async getById(tenantId: string, id: string): Promise<MemoryItem | null> {
    const item = this.items.get(id);
    return item && item.tenantId === tenantId ? { ...item } : null;
  }
}

export class InMemoryDecisionStore implements DecisionStore {
  private records = new Map<string, DecisionRecord>();
  readonly embeddings = new Map<string, number[] | null>();

  async insert(record: DecisionRecord, embedding?: number[] | null): Promise<void> {
    this.records.set(record.id, { ...record });
    this.embeddings.set(record.id, embedding ?? null);
  }

  async list(tenantId: string): Promise<DecisionRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.tenantId === tenantId)
      .sort(byDecidedAtDesc)
      .map((r) => ({ ...r }));
  }

  async getById(tenantId: string, id: string): Promise<DecisionRecord | null> {
    const rec = this.records.get(id);
    return rec && rec.tenantId === tenantId ? { ...rec } : null;
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<DecisionRecord>,
    embedding?: number[] | null,
  ): Promise<DecisionRecord | null> {
    const rec = this.records.get(id);
    if (!rec || rec.tenantId !== tenantId) return null;
    const next: DecisionRecord = { ...rec, ...patch, id: rec.id, tenantId: rec.tenantId };
    this.records.set(id, next);
    if (embedding !== undefined) this.embeddings.set(id, embedding);
    return { ...next };
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec || rec.tenantId !== tenantId) return false;
    this.records.delete(id);
    this.embeddings.delete(id);
    return true;
  }
}

export class InMemoryPendingDecisionStore implements PendingDecisionStore {
  private items = new Map<string, PendingDecision>();

  async insert(pending: PendingDecision): Promise<void> {
    this.items.set(pending.id, { ...pending });
  }

  async listPending(tenantId: string): Promise<PendingDecision[]> {
    return [...this.items.values()]
      .filter((p) => p.tenantId === tenantId && p.status === "pending")
      .sort((a, z) => z.extractedAt.localeCompare(a.extractedAt))
      .map((p) => ({ ...p }));
  }

  async getById(tenantId: string, id: string): Promise<PendingDecision | null> {
    const item = this.items.get(id);
    return item && item.tenantId === tenantId ? { ...item } : null;
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<PendingDecision>,
  ): Promise<PendingDecision | null> {
    const item = this.items.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    const next: PendingDecision = { ...item, ...patch, id: item.id, tenantId: item.tenantId };
    this.items.set(id, next);
    return { ...next };
  }
}
