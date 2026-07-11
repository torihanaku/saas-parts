/**
 * Minimal LLM caller interfaces — the kit never talks to a provider directly.
 *
 * @torihanaku/claude-api の generateJson / generateText / callClaude が
 * そのままこれらを満たす（README 参照）。モックを注入すればオフラインで動く。
 *
 * 出典: dev-dashboard-v2 server/lib/claude-api-client.ts の呼び出しシグネチャを
 * インターフェース化（実装は持たない）。
 */

/** Structured-output + free-text generation (planner / orchestrator 用). */
export interface LlmCaller {
  /**
   * Generate JSON matching the fallback's shape. On parse failure the
   * implementation should return `fallback`.
   */
  generateJson<T>(system: string, prompt: string, fallback: T): Promise<T>;
  /** Plain text completion. */
  generateText(system: string, prompt: string): Promise<string>;
}

// ─── Tool-use loop wire types (Claude Messages API 互換の最小形) ─────────────

export interface LlmTextBlock {
  type: "text";
  text: string;
}

export interface LlmToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmContentBlock =
  | LlmTextBlock
  | LlmToolUseBlock
  | { type: string; [key: string]: unknown };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | unknown;
}

export interface LlmToolTurn {
  /** "tool_use" continues the loop; anything else ends it. */
  stopReason: string;
  blocks: LlmContentBlock[];
}

/** One model turn with tools attached. */
export type LlmToolCaller = (params: {
  system: string;
  messages: LlmMessage[];
  tools: unknown[];
}) => Promise<LlmToolTurn>;
