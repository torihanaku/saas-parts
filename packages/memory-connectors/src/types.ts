/**
 * @torihanaku/memory-connectors — shared types + injected interfaces.
 *
 * Concrete Notion / Slack extractors + the embedding cost pipeline, ported from
 * 実運用SaaS `server/lib/institutional-memory/*`. All external I/O (Notion
 * / Slack HTTP, LLM, embeddings, cost ledger) is injected, so this package has
 * no direct SDK / secret dependency.
 *
 * The extractors emit `SourceCandidate[]` — the exact shape
 * `@torihanaku/kit-decision-memory`'s `SourceExtractor.fetchCandidates()`
 * returns — so they pair with that kit's `DecisionExtractorService` (no import).
 */

/**
 * A single reviewable candidate from an external source. Matches
 * kit-decision-memory's `SourceExtractor` contract.
 */
export interface SourceCandidate {
  /** Reference to the source message (permalink / page id). */
  sourceRef: string;
  rawText: string;
  /** ISO-8601. Omitted → caller uses now(). */
  decidedAt?: string;
}

/** Decision type vocabulary shared across memory sources. */
export type DecisionType = "start" | "stop" | "change" | "pivot" | "archive";

/**
 * Injected LLM JSON surface. The system prompt instructs the model to return
 * valid JSON; the implementation returns `fallback` on any error.
 */
export interface MemoryLlmClient {
  generateJson<T>(
    system: string,
    userPrompt: string,
    fallback: T,
    options?: { maxTokens?: number; timeout?: number },
  ): Promise<T>;
}

/** Injected structured logger. */
export interface MemoryLogger {
  info(scope: string, message: string): void;
  warn(scope: string, message: string): void;
  error(scope: string, err: unknown): void;
}

export const NOOP_LOGGER: MemoryLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
