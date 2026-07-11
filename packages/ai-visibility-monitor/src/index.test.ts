import { describe, it, expect, vi } from "vitest";
import {
  runVisibilityMonitor,
  createOpenAiEngine,
  type EngineCaller,
  type VisibilityStore,
  type MentionAnalyzer,
  type FetchLike,
} from "./index";

const fixedNow = () => new Date("2026-07-11T00:00:00.000Z");

function makeStore(over: Partial<VisibilityStore> = {}): VisibilityStore {
  return {
    listEnabledQueries: vi.fn().mockResolvedValue([]),
    insertResult: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const mentioned: MentionAnalyzer = async () => ({ brand_mentioned: true, mention_context: "foo brand is great" });

describe("runVisibilityMonitor — gating", () => {
  it("returns disabled when the flag is off", async () => {
    const store = makeStore();
    const r = await runVisibilityMonitor({ engines: {}, analyze: mentioned, store, isEnabled: () => false });
    expect(r.status).toBe("disabled");
    expect(store.listEnabledQueries).not.toHaveBeenCalled();
  });

  it("aborts when preflight is not ready", async () => {
    const store = makeStore();
    const logger = { error: vi.fn() };
    const r = await runVisibilityMonitor({ engines: {}, analyze: mentioned, store, isEnabled: () => true, ready: () => false, logger });
    expect(r.status).toBe("not_ready");
    expect(logger.error).toHaveBeenCalled();
    expect(store.listEnabledQueries).not.toHaveBeenCalled();
  });
});

describe("runVisibilityMonitor — empty paths", () => {
  it("no inserts when there are no queries", async () => {
    const store = makeStore({ listEnabledQueries: vi.fn().mockResolvedValue([]) });
    const r = await runVisibilityMonitor({ engines: { openai: async () => "x" }, analyze: mentioned, store, isEnabled: () => true });
    expect(r.resultsInserted).toBe(0);
    expect(store.insertResult).not.toHaveBeenCalled();
  });

  it("handles null from the store without throwing", async () => {
    const store = makeStore({ listEnabledQueries: vi.fn().mockResolvedValue(null) });
    const r = await runVisibilityMonitor({ engines: { openai: async () => "x" }, analyze: mentioned, store, isEnabled: () => true });
    expect(r.status).toBe("ran");
    expect(r.resultsInserted).toBe(0);
  });
});

describe("runVisibilityMonitor — sampling", () => {
  it("samples every engine per query and records results in order", async () => {
    const store = makeStore({
      listEnabledQueries: vi.fn().mockResolvedValue([{ id: "q1", tenant_id: "t1", keyword: "best cloud", enabled: true }]),
    });
    const engines: Record<string, EngineCaller> = {
      openai: async () => "openai response",
      perplexity: async () => "perplexity response",
      gemini: async () => "gemini response",
    };
    const r = await runVisibilityMonitor({ engines, analyze: mentioned, store, isEnabled: () => true, now: fixedNow });
    expect(r.resultsInserted).toBe(3);
    const providers = vi.mocked(store.insertResult).mock.calls.map((c) => (c[0] as { provider: string }).provider);
    expect(providers).toEqual(["openai", "perplexity", "gemini"]);
    expect(vi.mocked(store.insertResult).mock.calls[0]![0]).toMatchObject({
      query_id: "q1",
      brand_mentioned: true,
      sampled_at: "2026-07-11T00:00:00.000Z",
    });
  });

  it("skips engines that return an empty response", async () => {
    const store = makeStore({
      listEnabledQueries: vi.fn().mockResolvedValue([{ id: "q1", tenant_id: "t1", keyword: "test", enabled: true }]),
    });
    const engines: Record<string, EngineCaller> = {
      openai: async () => "",
      perplexity: async () => "has text",
      gemini: async () => "",
    };
    const r = await runVisibilityMonitor({ engines, analyze: mentioned, store, isEnabled: () => true });
    expect(r.resultsInserted).toBe(1);
  });

  it("catches top-level errors and logs", async () => {
    const store = makeStore({ listEnabledQueries: vi.fn().mockRejectedValue(new Error("DB down")) });
    const logger = { error: vi.fn() };
    const r = await runVisibilityMonitor({ engines: {}, analyze: mentioned, store, isEnabled: () => true, logger });
    expect(r.status).toBe("ran");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("ai-visibility failed: DB down"));
  });
});

describe("createOpenAiEngine", () => {
  function makeFetch(response: unknown, ok = true, status = 200): FetchLike {
    return vi.fn().mockResolvedValue({
      ok,
      status,
      text: async () => "",
      json: async () => response,
    });
  }

  it("returns the message content on success", async () => {
    const fetchImpl = makeFetch({ choices: [{ message: { content: "openai answer" } }] });
    const engine = createOpenAiEngine({ fetchImpl, getApiKey: () => "sk-test" });
    expect(await engine("kw", "t1")).toBe("openai answer");
  });

  it("skips (returns '') when the API key is missing", async () => {
    const fetchImpl = makeFetch({});
    const engine = createOpenAiEngine({ fetchImpl, getApiKey: () => "" });
    expect(await engine("kw", "t1")).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns '' on a non-OK response", async () => {
    const fetchImpl = makeFetch({}, false, 500);
    const engine = createOpenAiEngine({ fetchImpl, getApiKey: () => "sk-test" });
    expect(await engine("kw", "t1")).toBe("");
  });

  it("returns '' and logs when fetch throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network")) as unknown as FetchLike;
    const logger = { error: vi.fn() };
    const engine = createOpenAiEngine({ fetchImpl, getApiKey: () => "sk-test", logger });
    expect(await engine("kw", "t1")).toBe("");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("OpenAI fetch exception"));
  });
});
