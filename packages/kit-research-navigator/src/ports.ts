/**
 * 注入ポイント (ports)。
 *
 * このキットは LLM・埋め込み・外部シグナルソース・課題トラッカー・永続化を
 * すべてインターフェイス経由で受け取る。実装 (Anthropic API / Supabase /
 * GitHub API 等) はアプリ側で用意して注入する。
 */
import type {
  Card,
  CardAction,
  CardLearning,
  ExternalIssue,
  FailurePattern,
  NewSignal,
  Signal,
  SignalContext,
  Stack,
  StackMatch,
  Verdict,
} from "./types";

// ---------------------------------------------------------------------------
// LLM / Embedding
// ---------------------------------------------------------------------------

export interface LlmRequest {
  system?: string;
  user: string;
  model?: string;
  maxTokens?: number;
}

/**
 * LLM 呼び出しの抽象。generateJson は生成失敗・パース失敗時に null を返すこと
 * (throw しない)。元実装の claude-api-client generateJson/generateText に対応。
 */
export interface LlmClient {
  generateJson<T>(req: LlmRequest): Promise<T | null>;
  generateText(req: LlmRequest): Promise<string>;
}

/** テキスト → 埋め込みベクトル。 */
export type Embedder = (text: string) => Promise<number[]>;

/**
 * URL 到達性チェッカー。与えた URL のうち到達可能なものだけを返す。
 * 元実装の url-validator.filterReachableUrls に対応。
 * 省略時は「全 URL 到達可能」として扱う。
 */
export type UrlChecker = (urls: string[]) => Promise<string[]>;

// ---------------------------------------------------------------------------
// Signal sources
// ---------------------------------------------------------------------------

export interface SignalSourceContext {
  userId: string;
}

/**
 * 外部シグナルソースの抽象。HN / 検索 API / ニュース API 等を差し込む。
 * fetch は失敗時に throw してよい (集約側 fetchAllSignals が握りつぶして続行する)。
 */
export interface SignalSource {
  name: string;
  fetch(ctx: SignalSourceContext): Promise<NewSignal[]>;
}

// ---------------------------------------------------------------------------
// Issue provider (GitHub 等の課題トラッカーの一般化)
// ---------------------------------------------------------------------------

export interface IssueProvider {
  listOpenIssues(): Promise<ExternalIssue[]>;
  /** 作成できたら issue の URL を返す。失敗は null。 */
  createIssue(input: {
    title: string;
    body: string;
    targetRepo?: string;
  }): Promise<{ url: string } | null>;
}

// ---------------------------------------------------------------------------
// Stores (永続化の抽象)
// ---------------------------------------------------------------------------

export interface SignalStore {
  /** userId + url で重複したら null を返す (UNIQUE (user_id, url) 相当)。 */
  insert(
    userId: string,
    signal: NewSignal,
  ): Promise<Signal | null>;
  getById(userId: string, id: string): Promise<Signal | null>;
  listByIds(userId: string, ids: string[]): Promise<Signal[]>;
  /** fetchedAt >= sinceIso のシグナルを新しい順に返す。 */
  listSince(userId: string, sinceIso: string, limit: number): Promise<Signal[]>;
  saveEmbedding(id: string, embedding: number[]): Promise<void>;
  /** 埋め込み類似検索 (pgvector RPC 相当)。類似度降順。 */
  findRelated(
    userId: string,
    embedding: number[],
    opts?: { matchThreshold?: number; matchCount?: number },
  ): Promise<Signal[]>;
}

export interface ContextStore {
  insert(
    userId: string,
    ctx: Omit<SignalContext, "id" | "userId" | "createdAt">,
  ): Promise<SignalContext>;
  getBySignalId(userId: string, signalId: string): Promise<SignalContext | null>;
  listBySignalIds(userId: string, signalIds: string[]): Promise<SignalContext[]>;
  /** createdAt >= sinceIso かつ指定 verdict のもの。 */
  listByVerdictSince(
    userId: string,
    verdict: Verdict,
    sinceIso: string,
  ): Promise<SignalContext[]>;
  updateVerdict(id: string, verdict: Verdict): Promise<void>;
  /** 指定 verdict で createdAt < beforeIso のものを削除し、件数を返す。 */
  deleteOlderThan(
    userId: string,
    verdict: Verdict,
    beforeIso: string,
  ): Promise<number>;
}

export interface CardStore {
  insert(
    userId: string,
    card: Omit<Card, "id" | "userId" | "createdAt" | "updatedAt">,
  ): Promise<Card>;
  getById(userId: string, id: string): Promise<Card | null>;
  list(
    userId: string,
    opts?: { status?: Card["status"]; limit?: number },
  ): Promise<Card[]>;
  /** 部分更新。updatedAt はストア側で更新する。 */
  update(
    userId: string,
    id: string,
    patch: Partial<Omit<Card, "id" | "userId" | "createdAt">>,
  ): Promise<Card | null>;
}

export interface ActionStore {
  insert(
    userId: string,
    action: Omit<CardAction, "id" | "userId" | "createdAt">,
  ): Promise<CardAction>;
  listByCard(userId: string, cardId: string): Promise<CardAction[]>;
}

export interface LearningStore {
  insert(
    userId: string,
    learning: Omit<CardLearning, "id" | "userId" | "createdAt">,
  ): Promise<CardLearning>;
  listByCard(userId: string, cardId: string): Promise<CardLearning[]>;
}

export interface StackStore {
  listStacks(category?: string): Promise<Stack[]>;
  listFailurePatterns(opts?: {
    stackId?: string;
    severity?: string;
  }): Promise<FailurePattern[]>;
  /** 埋め込み類似検索 (match_nav_stacks RPC 相当)。類似度降順。 */
  matchByEmbedding(
    embedding: number[],
    opts?: {
      matchThreshold?: number;
      matchCount?: number;
      categoryFilter?: string;
    },
  ): Promise<StackMatch[]>;
}
