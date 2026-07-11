/**
 * Tests ported from dev-dashboard-v2 tests/claude-api-client.test.ts,
 * adapted to the config-injected client factory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createClaudeClient,
  extractText,
  parseJsonResponse,
  DEFAULT_ANTHROPIC_MODEL,
  type ClaudeApiResponse,
  type ClaudeMessage,
} from "./claude-api-client";

function makeOkResponse(body: ClaudeApiResponse): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
function makeTextResponse(text: string): ClaudeApiResponse {
  return { type: "message", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 } };
}
function requestBody(fetchSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const init = fetchSpy.mock.calls[0]![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("callClaude", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { vi.restoreAllMocks(); });

  const client = () => createClaudeClient({ apiKey: "test-api-key" });

  it("sends POST to Anthropic API with correct headers", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("Hello")));
    const messages: ClaudeMessage[] = [{ role: "user", content: "Hi" }];
    await client().callClaude("You are a bot", messages);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0] as unknown as [string | URL, RequestInit];
    expect(url.toString()).toContain("anthropic.com");
    expect((options.headers as Record<string, string>)["x-api-key"]).toBe("test-api-key");
    expect(options.method).toBe("POST");
  });

  it("returns parsed JSON response on success", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("Generated text here")));
    const result = await client().callClaude("sys", [{ role: "user", content: "prompt" }]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.content![0]!.text).toBe("Generated text here");
  });

  it("throws on non-2xx HTTP status", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    await expect(
      createClaudeClient({ apiKey: "bad-key" }).callClaude("sys", [{ role: "user", content: "prompt" }]),
    ).rejects.toThrow("Claude API HTTP error: 401");
  });

  it("includes tools in request body when provided", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("ok")));
    const tools = [{ name: "search", description: "search docs", input_schema: {} }];
    await client().callClaude("sys", [{ role: "user", content: "prompt" }], { tools });
    expect(requestBody(fetchSpy).tools).toEqual(tools);
  });

  it("does not include tools key when tools is empty", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("ok")));
    await client().callClaude("sys", [{ role: "user", content: "prompt" }], { tools: [] });
    expect(requestBody(fetchSpy)).not.toHaveProperty("tools");
  });

  it("respects maxTokens option", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("ok")));
    await client().callClaude("sys", [{ role: "user", content: "prompt" }], { maxTokens: 1234 });
    expect(requestBody(fetchSpy).max_tokens).toBe(1234);
  });

  it("uses default maxTokens of 4000", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("ok")));
    await client().callClaude("sys", [{ role: "user", content: "prompt" }]);
    expect(requestBody(fetchSpy).max_tokens).toBe(4000);
  });

  it("uses the default model unless overridden in config", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("ok")));
    await client().callClaude("sys", [{ role: "user", content: "prompt" }]);
    expect(requestBody(fetchSpy).model).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it("uses configured model and apiUrl", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("ok")));
    const c = createClaudeClient({ apiKey: "test-key", model: "claude-test-1", apiUrl: "https://proxy.example.com/v1/messages" });
    await c.callClaude("sys", [{ role: "user", content: "prompt" }]);
    const [url] = fetchSpy.mock.calls[0] as unknown as [string | URL];
    expect(url.toString()).toBe("https://proxy.example.com/v1/messages");
    expect(requestBody(fetchSpy).model).toBe("claude-test-1");
  });
});

describe("usage hook", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("fires onUsage after a successful call", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("ok")));
    const onUsage = vi.fn();
    const c = createClaudeClient({ apiKey: "test-key", onUsage });
    await c.callClaude("sys", [{ role: "user", content: "prompt" }]);
    expect(onUsage).toHaveBeenCalledWith({ input_tokens: 10, output_tokens: 20 });
  });

  it("setUsageHook(null) disables the hook", async () => {
    fetchSpy.mockResolvedValue(makeOkResponse(makeTextResponse("ok")));
    const onUsage = vi.fn();
    const c = createClaudeClient({ apiKey: "test-key", onUsage });
    c.setUsageHook(null);
    await c.callClaude("sys", [{ role: "user", content: "prompt" }]);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("a throwing hook is swallowed (call still succeeds)", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("still ok")));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = createClaudeClient({ apiKey: "test-key", onUsage: () => { throw new Error("boom"); } });
    const res = await c.callClaude("sys", [{ role: "user", content: "prompt" }]);
    expect(extractText(res)).toBe("still ok");
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("extractText", () => {
  it("returns text from first text block", () => {
    expect(extractText(makeTextResponse("Hello, world!"))).toBe("Hello, world!");
  });
  it("returns empty string when content is undefined", () => {
    expect(extractText({ type: "message", stop_reason: "end_turn" })).toBe("");
  });
  it("returns empty string when no text block", () => {
    const res: ClaudeApiResponse = { type: "message", content: [{ type: "tool_use", id: "t1", name: "search", input: {} }], stop_reason: "tool_use" };
    expect(extractText(res)).toBe("");
  });
  it('throws when type is "error"', () => {
    const res: ClaudeApiResponse = { type: "error", error: { type: "auth", message: "Invalid API key" } };
    expect(() => extractText(res)).toThrow("Invalid API key");
  });
  it("throws with generic message when error has no message", () => {
    const res: ClaudeApiResponse = { type: "error", error: { type: "unknown", message: "" } };
    expect(() => extractText(res)).toThrow("Claude API error");
  });
});

describe("parseJsonResponse", () => {
  it("parses valid JSON", () => {
    expect(parseJsonResponse(makeTextResponse('{"key":"value","count":42}'), {})).toEqual({ key: "value", count: 42 });
  });
  it("returns fallback for non-JSON text", () => {
    const fallback = { default: true };
    expect(parseJsonResponse(makeTextResponse("plain text"), fallback)).toEqual(fallback);
  });
  it("returns fallback for empty response", () => {
    expect(parseJsonResponse({ type: "message" }, [])).toEqual([]);
  });
  it("returns fallback for error response", () => {
    const res: ClaudeApiResponse = { type: "error", error: { type: "overloaded", message: "Overloaded" } };
    expect(parseJsonResponse(res, { items: [] })).toEqual({ items: [] });
  });
});

describe("generateText", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { vi.restoreAllMocks(); });

  const client = () => createClaudeClient({ apiKey: "test-key" });

  it("returns extracted text on success", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("Great output!")));
    expect(await client().generateText("sys", "prompt")).toBe("Great output!");
  });
  it("returns empty string when fetch throws", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network error"));
    expect(await client().generateText("sys", "prompt")).toBe("");
  });
  it("returns empty string on HTTP error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("err", { status: 500 }));
    expect(await client().generateText("sys", "prompt")).toBe("");
  });
  it("passes maxTokens through", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("ok")));
    await client().generateText("sys", "prompt", { maxTokens: 2000 });
    expect(requestBody(fetchSpy).max_tokens).toBe(2000);
  });
});

describe("generateJson", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { vi.restoreAllMocks(); });

  const client = () => createClaudeClient({ apiKey: "test-key" });

  it("parses and returns JSON", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse('{"items":["a","b"]}')));
    expect(await client().generateJson("sys", "prompt", { items: [] })).toEqual({ items: ["a", "b"] });
  });
  it("returns fallback for non-JSON", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("Not JSON")));
    expect(await client().generateJson("sys", "prompt", { items: [] })).toEqual({ items: [] });
  });
  it("returns fallback when fetch throws", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("error"));
    expect(await client().generateJson("sys", "prompt", 42)).toBe(42);
  });
});

describe("runToolLoop", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, "fetch"); });
  afterEach(() => { vi.restoreAllMocks(); });

  const client = () => createClaudeClient({ apiKey: "test-key" });

  it("returns text immediately when stop_reason is not tool_use", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse(makeTextResponse("Direct answer")));
    const executor = vi.fn();
    const result = await client().runToolLoop("sys", [{ role: "user", content: "query" }], [], executor);
    expect(result.text).toBe("Direct answer");
    expect(result.iterations).toBe(1);
    expect(executor).not.toHaveBeenCalled();
  });

  it("calls executor for tool_use blocks and continues loop", async () => {
    const toolUseResponse: ClaudeApiResponse = { type: "message", content: [{ type: "tool_use", id: "tool1", name: "search", input: { query: "test" } }], stop_reason: "tool_use" };
    fetchSpy.mockResolvedValueOnce(makeOkResponse(toolUseResponse)).mockResolvedValueOnce(makeOkResponse(makeTextResponse("Final answer")));
    const executor = vi.fn().mockResolvedValue("search results");
    const result = await client().runToolLoop("sys", [{ role: "user", content: "q" }], [{ name: "search" }], executor);
    expect(executor).toHaveBeenCalledOnce();
    expect(result.toolsUsed).toContain("search");
    expect(result.text).toBe("Final answer");
  });

  it("returns max-iterations message when cap is reached", async () => {
    const toolUseBody: ClaudeApiResponse = { type: "message", content: [{ type: "tool_use", id: "tool1", name: "loop_tool", input: {} }], stop_reason: "tool_use" };
    fetchSpy.mockImplementation(() => Promise.resolve(makeOkResponse(toolUseBody)));
    const executor = vi.fn().mockResolvedValue("result");
    const result = await client().runToolLoop("sys", [{ role: "user", content: "q" }], [], executor, { maxIterations: 3 });
    expect(result.iterations).toBe(3);
    expect(result.text).toContain("処理が複雑すぎます");
  });

  it("returns placeholder when no text block present", async () => {
    const res: ClaudeApiResponse = { type: "message", content: [], stop_reason: "end_turn" };
    fetchSpy.mockResolvedValueOnce(makeOkResponse(res));
    const result = await client().runToolLoop("sys", [{ role: "user", content: "q" }], [], vi.fn());
    expect(result.text).toBe("応答を生成できませんでした");
  });
});
