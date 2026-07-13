/**
 * Injectable LLM caller interfaces.
 *
 * このパッケージは LLM プロバイダに直接触れない。呼び出し側が
 * `@torihanaku/claude-api` の `generateJson` / `generateText`（あるいは
 * 任意のモック）を注入する。シグネチャは原典 実運用SaaS の
 * `server/lib/claude-api-client.ts` と互換に保っている。
 *
 * どちらの実装も「失敗時は fallback を返す（throw しない）」ことが望ましい。
 */

export interface LlmCallOptions {
  maxTokens?: number;
  timeout?: number;
}

/** 構造化 JSON 生成。parse 失敗時は fallback を返す想定。 */
export type GenerateJson = <T>(
  apiKey: string,
  system: string,
  userPrompt: string,
  fallback: T,
  options?: LlmCallOptions,
) => Promise<T>;

/** 自由テキスト生成。 */
export type GenerateText = (
  apiKey: string,
  system: string,
  userPrompt: string,
  options?: LlmCallOptions,
) => Promise<string>;
