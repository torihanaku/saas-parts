/**
 * インメモリのストア実装。テスト・プロトタイピング用。
 * 本番では SignalStore 等を RDB (README の SQL スキーマ参照) で実装して注入する。
 */
import type {
  ActionStore,
  CardStore,
  ContextStore,
  LearningStore,
  SignalStore,
  StackStore,
} from "./ports";
import type {
  Card,
  CardAction,
  CardLearning,
  FailurePattern,
  NewSignal,
  Signal,
  SignalContext,
  Stack,
  StackMatch,
  Verdict,
} from "./types";

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface MemoryStoreOptions {
  now?: () => Date;
}

function makeIdGen(prefix: string): () => string {
  let seq = 0;
  return () => `${prefix}-${++seq}`;
}

export class MemorySignalStore implements SignalStore {
  private signals = new Map<string, Signal>();
  private embeddings = new Map<string, number[]>();
  private nextId = makeIdGen("sig");
  private now: () => Date;

  constructor(opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async insert(userId: string, signal: NewSignal): Promise<Signal | null> {
    for (const existing of this.signals.values()) {
      if (existing.userId === userId && existing.url === signal.url) {
        return null; // UNIQUE (user_id, url) 相当
      }
    }
    const row: Signal = {
      id: this.nextId(),
      userId,
      source: signal.source,
      url: signal.url,
      title: signal.title,
      body: signal.body ?? null,
      fetchedAt: signal.fetchedAt,
      seenAt: null,
      createdAt: this.now().toISOString(),
    };
    this.signals.set(row.id, row);
    return row;
  }

  async getById(userId: string, id: string): Promise<Signal | null> {
    const row = this.signals.get(id);
    return row && row.userId === userId ? row : null;
  }

  async listByIds(userId: string, ids: string[]): Promise<Signal[]> {
    const set = new Set(ids);
    return [...this.signals.values()].filter(
      (s) => s.userId === userId && set.has(s.id),
    );
  }

  async listSince(
    userId: string,
    sinceIso: string,
    limit: number,
  ): Promise<Signal[]> {
    return [...this.signals.values()]
      .filter((s) => s.userId === userId && s.fetchedAt >= sinceIso)
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
      .slice(0, limit);
  }

  async saveEmbedding(id: string, embedding: number[]): Promise<void> {
    this.embeddings.set(id, embedding);
  }

  async findRelated(
    userId: string,
    embedding: number[],
    opts: { matchThreshold?: number; matchCount?: number } = {},
  ): Promise<Signal[]> {
    const threshold = opts.matchThreshold ?? 0.7;
    const count = opts.matchCount ?? 10;
    const scored: { signal: Signal; similarity: number }[] = [];
    for (const [id, emb] of this.embeddings) {
      const signal = this.signals.get(id);
      if (!signal || signal.userId !== userId) continue;
      const similarity = cosineSimilarity(embedding, emb);
      if (similarity >= threshold) scored.push({ signal, similarity });
    }
    return scored
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, count)
      .map((s) => s.signal);
  }
}

export class MemoryContextStore implements ContextStore {
  private contexts = new Map<string, SignalContext>();
  private nextId = makeIdGen("ctx");
  private now: () => Date;

  constructor(opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async insert(
    userId: string,
    ctx: Omit<SignalContext, "id" | "userId" | "createdAt">,
  ): Promise<SignalContext> {
    const row: SignalContext = {
      ...ctx,
      id: this.nextId(),
      userId,
      createdAt: this.now().toISOString(),
    };
    this.contexts.set(row.id, row);
    return row;
  }

  /** テスト用: createdAt を明示指定して直接投入する。 */
  seed(row: SignalContext): void {
    this.contexts.set(row.id, row);
  }

  async getBySignalId(
    userId: string,
    signalId: string,
  ): Promise<SignalContext | null> {
    for (const ctx of this.contexts.values()) {
      if (ctx.userId === userId && ctx.signalId === signalId) return ctx;
    }
    return null;
  }

  async listBySignalIds(
    userId: string,
    signalIds: string[],
  ): Promise<SignalContext[]> {
    const set = new Set(signalIds);
    return [...this.contexts.values()].filter(
      (c) => c.userId === userId && set.has(c.signalId),
    );
  }

  async listByVerdictSince(
    userId: string,
    verdict: Verdict,
    sinceIso: string,
  ): Promise<SignalContext[]> {
    return [...this.contexts.values()].filter(
      (c) =>
        c.userId === userId && c.verdict === verdict && c.createdAt >= sinceIso,
    );
  }

  async updateVerdict(id: string, verdict: Verdict): Promise<void> {
    const row = this.contexts.get(id);
    if (row) this.contexts.set(id, { ...row, verdict });
  }

  async deleteOlderThan(
    userId: string,
    verdict: Verdict,
    beforeIso: string,
  ): Promise<number> {
    let deleted = 0;
    for (const [id, c] of this.contexts) {
      if (c.userId === userId && c.verdict === verdict && c.createdAt < beforeIso) {
        this.contexts.delete(id);
        deleted++;
      }
    }
    return deleted;
  }
}

export class MemoryCardStore implements CardStore {
  private cards = new Map<string, Card>();
  private nextId = makeIdGen("card");
  private now: () => Date;

  constructor(opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async insert(
    userId: string,
    card: Omit<Card, "id" | "userId" | "createdAt" | "updatedAt">,
  ): Promise<Card> {
    const nowIso = this.now().toISOString();
    const row: Card = {
      ...card,
      id: this.nextId(),
      userId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.cards.set(row.id, row);
    return row;
  }

  async getById(userId: string, id: string): Promise<Card | null> {
    const row = this.cards.get(id);
    return row && row.userId === userId ? row : null;
  }

  async list(
    userId: string,
    opts: { status?: Card["status"]; limit?: number } = {},
  ): Promise<Card[]> {
    const limit = opts.limit ?? 20;
    return [...this.cards.values()]
      .filter(
        (c) =>
          c.userId === userId && (!opts.status || c.status === opts.status),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  async update(
    userId: string,
    id: string,
    patch: Partial<Omit<Card, "id" | "userId" | "createdAt">>,
  ): Promise<Card | null> {
    const row = this.cards.get(id);
    if (!row || row.userId !== userId) return null;
    const updated: Card = {
      ...row,
      ...patch,
      id: row.id,
      userId: row.userId,
      createdAt: row.createdAt,
      updatedAt: this.now().toISOString(),
    };
    this.cards.set(id, updated);
    return updated;
  }
}

export class MemoryActionStore implements ActionStore {
  private actions = new Map<string, CardAction>();
  private nextId = makeIdGen("act");
  private now: () => Date;

  constructor(opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async insert(
    userId: string,
    action: Omit<CardAction, "id" | "userId" | "createdAt">,
  ): Promise<CardAction> {
    const row: CardAction = {
      ...action,
      id: this.nextId(),
      userId,
      createdAt: this.now().toISOString(),
    };
    this.actions.set(row.id, row);
    return row;
  }

  async listByCard(userId: string, cardId: string): Promise<CardAction[]> {
    return [...this.actions.values()]
      .filter((a) => a.userId === userId && a.cardId === cardId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
}

export class MemoryLearningStore implements LearningStore {
  private learnings = new Map<string, CardLearning>();
  private nextId = makeIdGen("lrn");
  private now: () => Date;

  constructor(opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async insert(
    userId: string,
    learning: Omit<CardLearning, "id" | "userId" | "createdAt">,
  ): Promise<CardLearning> {
    const row: CardLearning = {
      ...learning,
      id: this.nextId(),
      userId,
      createdAt: this.now().toISOString(),
    };
    this.learnings.set(row.id, row);
    return row;
  }

  async listByCard(userId: string, cardId: string): Promise<CardLearning[]> {
    return [...this.learnings.values()]
      .filter((l) => l.userId === userId && l.cardId === cardId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
}

export class MemoryStackStore implements StackStore {
  private stacks: Stack[] = [];
  private embeddings = new Map<string, number[]>();
  private failures: FailurePattern[] = [];

  addStack(stack: Stack, embedding?: number[]): void {
    this.stacks.push(stack);
    if (embedding) this.embeddings.set(stack.id, embedding);
  }

  addFailurePattern(fp: FailurePattern): void {
    this.failures.push(fp);
  }

  async listStacks(category?: string): Promise<Stack[]> {
    return this.stacks
      .filter((s) => !category || s.category === category)
      .sort(
        (a, b) =>
          a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
      );
  }

  async listFailurePatterns(
    opts: { stackId?: string; severity?: string } = {},
  ): Promise<FailurePattern[]> {
    return this.failures
      .filter(
        (f) =>
          (!opts.stackId || f.stackId === opts.stackId) &&
          (!opts.severity || f.severity === opts.severity),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async matchByEmbedding(
    embedding: number[],
    opts: {
      matchThreshold?: number;
      matchCount?: number;
      categoryFilter?: string;
    } = {},
  ): Promise<StackMatch[]> {
    const threshold = opts.matchThreshold ?? 0.3;
    const count = opts.matchCount ?? 8;
    const scored: StackMatch[] = [];
    for (const stack of this.stacks) {
      if (opts.categoryFilter && stack.category !== opts.categoryFilter) continue;
      const emb = this.embeddings.get(stack.id);
      if (!emb) continue;
      const similarity = cosineSimilarity(embedding, emb);
      if (similarity >= threshold) scored.push({ ...stack, similarity });
    }
    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, count);
  }
}
