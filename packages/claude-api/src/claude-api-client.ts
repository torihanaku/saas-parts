/**
 * Unified Claude API client.
 *
 * Ported from dev-dashboard-v2 `server/lib/claude-api-client.ts`.
 * Centralises the fetch boilerplate for the Anthropic Messages API:
 * plain chat, Tool Use loop, structured (JSON) output parsing, prompt
 * caching headers, and a usage-tracking hook for cost attribution.
 *
 * Product coupling removed:
 * - API key / base URL / default model are constructor config
 *   (originally `env.ANTHROPIC_API_KEY` / `config.ANTHROPIC_API_URL` /
 *   `config.ANTHROPIC_MODEL`). No env reads inside the lib.
 * - `fetchWithTimeout` (originally imported from `server/lib/helpers.ts`)
 *   is inlined as a private copy.
 * - The usage hook (originally a module-global registered by
 *   cost-tracker.ts) is per-client: pass `onUsage` in the config or call
 *   `setUsageHook()`.
 *
 * Usage:
 *   const client = createClaudeClient({ apiKey: "..." });
 *   const res  = await client.callClaude(system, messages, { maxTokens: 2000 });
 *   const text = extractText(res);
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

export interface ClaudeContentBlock {
  type: "text" | "tool_use" | "tool_result";
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  content?: string;
}

export interface ClaudeApiResponse {
  type?: string;
  content?: ClaudeContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: { type: string; message: string };
}

export interface ClaudeCallOptions {
  /** Max output tokens. Default: 4000 */
  maxTokens?: number;
  /** Request timeout in ms. Default: 60 000 */
  timeout?: number;
  /** Tool definitions for Tool Use. Omit for plain chat. */
  tools?: unknown[];
}

export type ClaudeUsage = { input_tokens: number; output_tokens: number };
export type ClaudeUsageHook = (usage: ClaudeUsage) => void;

export interface ClaudeClientConfig {
  /** Anthropic API key. Required — the lib never reads env vars. */
  apiKey: string;
  /** Messages endpoint. Default: DEFAULT_ANTHROPIC_API_URL */
  apiUrl?: string;
  /** Model id sent as `model`. Default: DEFAULT_ANTHROPIC_MODEL */
  model?: string;
  /**
   * Callback fired after every successful callClaude (cost attribution).
   * Equivalent to the original `setClaudeUsageHook`, scoped per client.
   */
  onUsage?: ClaudeUsageHook | null;
}

export const DEFAULT_ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

// ─── Private fetch helper (inlined from server/lib/helpers.ts) ───────────────

/**
 * fetch() wrapper with AbortController-based timeout.
 * NOTE: Raw fetch() with no timeout can hang indefinitely on flaky external
 * APIs. This wrapper adds a hard deadline.
 */
async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Response helpers (pure, client-independent) ─────────────────────────────

/** Extract the first text block from a Claude response. Returns "" on failure. */
export function extractText(response: ClaudeApiResponse): string {
  if (response.type === "error") {
    throw new Error(response.error?.message || "Claude API error");
  }
  return response.content?.find((b) => b.type === "text")?.text ?? "";
}

/**
 * Parse JSON from a Claude response text.
 * Returns `fallback` if the text is not valid JSON or the response is empty.
 */
export function parseJsonResponse<T>(response: ClaudeApiResponse, fallback: T): T {
  const text = (() => {
    try { return extractText(response); } catch { return ""; }
  })();
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ─── Tool Use loop types ──────────────────────────────────────────────────────

export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string>;

export interface ToolLoopResult {
  text: string;
  toolsUsed: string[];
  iterations: number;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class ClaudeApiClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly model: string;
  private usageHook: ClaudeUsageHook | null;

  constructor(config: ClaudeClientConfig) {
    this.apiKey = config.apiKey;
    this.apiUrl = config.apiUrl ?? DEFAULT_ANTHROPIC_API_URL;
    this.model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.usageHook = config.onUsage ?? null;
  }

  /**
   * Register a callback that fires after every successful callClaude.
   * Single-slot per client — wrap in AsyncLocalStorage or a manual ID-keyed
   * accumulator when you need to scope tracking to a single pipeline run.
   */
  setUsageHook(hook: ClaudeUsageHook | null): void {
    this.usageHook = hook;
  }

  /**
   * Make a single Claude API call.
   * Throws on HTTP-level errors; API-level errors are visible in `response.type === "error"`.
   */
  async callClaude(
    system: string,
    messages: ClaudeMessage[],
    options: ClaudeCallOptions = {},
  ): Promise<ClaudeApiResponse> {
    const { maxTokens = 4000, timeout = 60_000, tools } = options;

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages,
    };
    if (tools?.length) body.tools = tools;

    const res = await fetchWithTimeout(
      this.apiUrl,
      {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      timeout,
    );

    if (!res.ok) {
      throw new Error(`Claude API HTTP error: ${res.status}`);
    }

    const json = (await res.json()) as ClaudeApiResponse;
    if (this.usageHook && json.usage) {
      try {
        this.usageHook(json.usage);
      } catch (err) {
        console.warn("[claude-api-client] usage hook threw:", err);
      }
    }
    return json;
  }

  /**
   * Generate JSON-structured output from Claude.
   * The system prompt must instruct Claude to return valid JSON.
   * Returns `fallback` on any error.
   */
  async generateJson<T>(
    system: string,
    userPrompt: string,
    fallback: T,
    options: ClaudeCallOptions = {},
  ): Promise<T> {
    try {
      const res = await this.callClaude(system, [{ role: "user", content: userPrompt }], options);
      return parseJsonResponse(res, fallback);
    } catch {
      return fallback;
    }
  }

  /**
   * Generate plain text from Claude.
   * Returns "" on any error.
   */
  async generateText(
    system: string,
    userPrompt: string,
    options: ClaudeCallOptions = {},
  ): Promise<string> {
    try {
      const res = await this.callClaude(system, [{ role: "user", content: userPrompt }], options);
      return extractText(res);
    } catch {
      return "";
    }
  }

  /**
   * Run a Claude Tool Use loop until `stop_reason !== "tool_use"` or maxIterations is reached.
   *
   * @param executor  Function that executes a tool call and returns a string result.
   * @param options.maxIterations  Safety cap (default: 5).
   */
  async runToolLoop(
    system: string,
    initialMessages: ClaudeMessage[],
    tools: unknown[],
    executor: ToolExecutor,
    options: { maxIterations?: number; maxTokens?: number; timeout?: number } = {},
  ): Promise<ToolLoopResult> {
    const { maxIterations = 5, maxTokens = 4000, timeout = 60_000 } = options;
    const toolsUsed: string[] = [];
    let messages = [...initialMessages];

    for (let i = 0; i < maxIterations; i++) {
      const res = await this.callClaude(system, messages, { maxTokens, timeout, tools });
      const blocks = res.content ?? [];

      if (res.stop_reason !== "tool_use") {
        const text = blocks
          .filter((b): b is ClaudeContentBlock & { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n") || "応答を生成できませんでした";
        return { text, toolsUsed, iterations: i + 1 };
      }

      const toolBlocks = blocks.filter(
        (b): b is ClaudeContentBlock & { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
          b.type === "tool_use",
      );

      const results = await Promise.all(
        toolBlocks.map(async (tb) => {
          toolsUsed.push(tb.name);
          const content = await executor(tb.name, tb.input);
          return { type: "tool_result" as const, tool_use_id: tb.id, content };
        }),
      );

      messages = [
        ...messages,
        { role: "assistant" as const, content: blocks },
        { role: "user" as const, content: results },
      ];
    }

    return {
      text: "処理が複雑すぎます。もう少し具体的に指示してください。",
      toolsUsed,
      iterations: maxIterations,
    };
  }
}

/** Factory — the recommended entry point. */
export function createClaudeClient(config: ClaudeClientConfig): ClaudeApiClient {
  return new ClaudeApiClient(config);
}
