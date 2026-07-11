/**
 * AI Search Visibility Monitor (ported from dev-dashboard-v2
 * server/lib/ai-visibility-job.ts).
 *
 * Periodically samples answers from AI search engines (ChatGPT / Perplexity /
 * Gemini) for a set of tracked keywords, classifies whether the brand is
 * mentioned, and records the result.
 *
 * Decoupled from the original:
 *   - each engine's API call     → injected `EngineCaller` (per engine)
 *   - the mention classifier      → injected `MentionAnalyzer` (LLM-backed)
 *   - Supabase read/write         → injected `VisibilityStore`
 *   - feature flag / env keys      → injected `isEnabled()` / config
 *
 * No `@torihanaku/*` imports, no `process.env`, no DB, no secrets. All API
 * keys live in the injected callers, never in this package.
 */

export interface VisibilityQuery {
  id: string;
  tenant_id: string;
  keyword: string;
  enabled: boolean;
}

export interface MentionAnalysis {
  brand_mentioned: boolean;
  mention_context: string;
}

export interface VisibilityResult {
  query_id: string;
  provider: string;
  response_text: string;
  brand_mentioned: boolean;
  mention_context: string;
  sampled_at: string;
}

/**
 * One AI-engine caller. Returns the engine's raw answer for a keyword, or an
 * empty string when unavailable (missing key, error, etc.). Must not throw for
 * routine failures — the monitor simply skips empty responses.
 */
export type EngineCaller = (keyword: string, tenantId: string) => Promise<string>;

/**
 * Classifies whether the tenant's brand is mentioned in a response. Injected so
 * the LLM/API key stays outside this package.
 */
export type MentionAnalyzer = (
  keyword: string,
  responseText: string,
  tenantId: string,
) => Promise<MentionAnalysis>;

export interface VisibilityStore {
  /** Enabled tracked queries to sample. */
  listEnabledQueries(): Promise<VisibilityQuery[] | null>;
  /** Persist one sampled result. */
  insertResult(result: VisibilityResult): Promise<unknown>;
}

export interface VisibilityLogger {
  warn?(message: string): void;
  error?(message: string): void;
}

export interface VisibilityMonitorConfig {
  /** Ordered map of provider name → engine caller. Insertion order is honored. */
  engines: Record<string, EngineCaller>;
  analyze: MentionAnalyzer;
  store: VisibilityStore;
  /** Feature gate (originally isEnabled("aiSearchVisibility")). */
  isEnabled: () => boolean;
  /**
   * Preflight guard: return false to abort the whole run (originally the
   * ANTHROPIC_API_KEY presence check). Defaults to always-ready.
   */
  ready?: () => boolean;
  logger?: VisibilityLogger;
  /** Injectable clock for deterministic `sampled_at` in tests. */
  now?: () => Date;
}

/**
 * Run one visibility sampling pass across all enabled queries and all
 * configured engines. Records a result per (query, engine) whenever the engine
 * returns a non-empty answer.
 */
export async function runVisibilityMonitor(config: VisibilityMonitorConfig): Promise<{
  status: "disabled" | "not_ready" | "ran";
  queriesSampled: number;
  resultsInserted: number;
}> {
  const { engines, analyze, store, logger } = config;
  const now = config.now ?? (() => new Date());

  if (!config.isEnabled()) {
    return { status: "disabled", queriesSampled: 0, resultsInserted: 0 };
  }
  if (config.ready && !config.ready()) {
    logger?.error?.("ai-visibility: preflight not ready — job aborted");
    return { status: "not_ready", queriesSampled: 0, resultsInserted: 0 };
  }

  let queriesSampled = 0;
  let resultsInserted = 0;

  try {
    const queries = await store.listEnabledQueries();
    if (!queries || !Array.isArray(queries)) {
      return { status: "ran", queriesSampled: 0, resultsInserted: 0 };
    }

    for (const query of queries) {
      queriesSampled += 1;
      for (const [provider, caller] of Object.entries(engines)) {
        const responseText = await caller(query.keyword, query.tenant_id);
        if (!responseText) continue;

        const analysis = await analyze(query.keyword, responseText, query.tenant_id);
        await store.insertResult({
          query_id: query.id,
          provider,
          response_text: responseText,
          brand_mentioned: analysis.brand_mentioned,
          mention_context: analysis.mention_context,
          sampled_at: now().toISOString(),
        });
        resultsInserted += 1;
      }
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger?.error?.(`ai-visibility failed: ${error.message}`);
  }

  return { status: "ran", queriesSampled, resultsInserted };
}

// ─── Optional helpers for building engine callers ─────────────────────────────

/** Minimal shape of an HTTP fetch (injected so the package has no global dep). */
export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

/**
 * Build an OpenAI-style chat engine caller. The API key and fetch impl are
 * injected; returns "" on any missing-key / non-OK / thrown condition (matching
 * the source's fail-soft behavior).
 */
export function createOpenAiEngine(deps: {
  fetchImpl: FetchLike;
  getApiKey: (tenantId: string) => Promise<string> | string;
  model?: string;
  logger?: VisibilityLogger;
}): EngineCaller {
  return async (keyword, tenantId) => {
    const apiKey = await deps.getApiKey(tenantId);
    if (!apiKey) {
      deps.logger?.warn?.("ai-visibility: OpenAI API key not set — skipping provider");
      return "";
    }
    try {
      const res = await deps.fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: deps.model ?? "gpt-4o-mini",
          messages: [{ role: "user", content: keyword }],
          max_tokens: 1000,
        }),
      });
      if (!res.ok) {
        deps.logger?.warn?.(`ai-visibility: OpenAI non-OK response (${res.status})`);
        return "";
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content || "";
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      deps.logger?.error?.(`ai-visibility: OpenAI fetch exception: ${error.message}`);
      return "";
    }
  };
}
