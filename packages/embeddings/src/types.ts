/**
 * Embedding provider abstraction.
 *
 * Ported verbatim from 実運用SaaS
 * `server/lib/embedding-providers/types.ts` (multi-provider registry).
 *
 * Active retrieval uses ONE primary provider (see `setPrimaryProvider` in
 * registry.ts). Additional providers can be registered for offline A/B
 * comparison.
 */

export interface EmbeddingProvider {
  /** Stable identifier, e.g. 'openai-3-small', 'bge-m3-deepinfra'. */
  readonly slug: string;
  /** Vector dimension produced by this provider. Must match retrieval column dim if used as primary. */
  readonly dimension: number;
  /** Maximum input tokens per call (provider limit). Used by callers to chunk long inputs. */
  readonly maxInputTokens: number;
  /** Embed a single text. Returns vector of length `dimension`. */
  embed(text: string): Promise<number[]>;
  /**
   * Embed N texts. Implementations should batch up to provider limits.
   * Returns array preserving input order. Length must equal input length.
   */
  embedBatch(texts: string[]): Promise<number[][]>;
}

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    public readonly providerSlug: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}
