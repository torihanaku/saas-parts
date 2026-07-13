/**
 * Injected LLM boundary. The original 実運用SaaS code imported a concrete
 * Claude API client (`generateJson` / `generateText`). Here those two calls are
 * abstracted into an `LlmClient` interface so the package carries no API key,
 * no `process.env`, and no network dependency of its own.
 */

export interface LlmGenerateOptions {
  maxTokens?: number;
  model?: string;
}

export interface LlmClient {
  /**
   * Produce a JSON object of type T. Implementations must return `fallback`
   * on any parse/transport error (never throw).
   */
  generateJson<T>(
    system: string,
    user: string,
    fallback: T,
    opts?: LlmGenerateOptions,
  ): Promise<T>;
  /** Produce free-form text. */
  generateText(system: string, user: string, opts?: LlmGenerateOptions): Promise<string>;
}
