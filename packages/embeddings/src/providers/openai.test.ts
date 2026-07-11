/**
 * Ported from dev-dashboard-v2 tests/embedding-providers/openai.test.ts.
 * The env mock is gone — the API key is now a factory argument, so the
 * missing-key path is directly testable.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createOpenAIProvider } from "./openai";
import { EmbeddingProviderError } from "../types";

const ORIGINAL_FETCH = global.fetch;
const TEST_KEY = "sk-test-key";

function makeFetchMock(response: { status?: number; statusText?: string; body: unknown }) {
  return vi.fn(async () =>
    new Response(typeof response.body === "string" ? response.body : JSON.stringify(response.body), {
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("createOpenAIProvider", () => {
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("throws when apiKey is empty", () => {
    expect(() => createOpenAIProvider("")).toThrow(EmbeddingProviderError);
  });

  it("provider has expected metadata", () => {
    const p = createOpenAIProvider(TEST_KEY);
    expect(p.slug).toBe("openai-3-small");
    expect(p.dimension).toBe(1536);
    expect(p.maxInputTokens).toBeGreaterThan(0);
  });

  it("embed() returns 1536-dim vector on successful response", async () => {
    const fakeVec = Array(1536).fill(0).map((_, i) => i / 1536);
    global.fetch = makeFetchMock({
      body: { data: [{ embedding: fakeVec, index: 0 }] },
    }) as unknown as typeof fetch;

    const p = createOpenAIProvider(TEST_KEY);
    const vec = await p.embed("hello world");
    expect(vec).toHaveLength(1536);
    expect(vec[0]).toBe(0);
  });

  it("embed() throws EmbeddingProviderError on non-2xx", async () => {
    global.fetch = makeFetchMock({
      status: 429,
      statusText: "Too Many Requests",
      body: "rate limited",
    }) as unknown as typeof fetch;

    const p = createOpenAIProvider(TEST_KEY);
    await expect(p.embed("hello")).rejects.toThrow(EmbeddingProviderError);
  });

  it("embed() throws when returned dim != 1536", async () => {
    global.fetch = makeFetchMock({
      body: { data: [{ embedding: [0.1, 0.2], index: 0 }] },
    }) as unknown as typeof fetch;

    const p = createOpenAIProvider(TEST_KEY);
    await expect(p.embed("hello")).rejects.toThrow(/unexpected dimension/);
  });

  it("embedBatch() preserves input order even if API returns out-of-order indices", async () => {
    const vec = (i: number) => Array(1536).fill(i / 100);
    global.fetch = makeFetchMock({
      body: {
        data: [
          { embedding: vec(2), index: 2 },
          { embedding: vec(0), index: 0 },
          { embedding: vec(1), index: 1 },
        ],
      },
    }) as unknown as typeof fetch;

    const p = createOpenAIProvider(TEST_KEY);
    const vecs = await p.embedBatch(["a", "b", "c"]);
    expect(vecs).toHaveLength(3);
    expect(vecs[0]![0]).toBeCloseTo(0);
    expect(vecs[1]![0]).toBeCloseTo(0.01);
    expect(vecs[2]![0]).toBeCloseTo(0.02);
  });

  it("embedBatch([]) returns []", async () => {
    const p = createOpenAIProvider(TEST_KEY);
    const vecs = await p.embedBatch([]);
    expect(vecs).toEqual([]);
  });

  it("embedBatch() chunks inputs >100 into multiple calls", async () => {
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { input: string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(
        JSON.stringify({
          data: inputs.map((_, i) => ({ embedding: Array(1536).fill(0.1), index: i })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    global.fetch = fakeFetch as unknown as typeof fetch;

    const p = createOpenAIProvider(TEST_KEY);
    const inputs = Array.from({ length: 250 }, (_, i) => `text-${i}`);
    const vecs = await p.embedBatch(inputs);

    expect(vecs).toHaveLength(250);
    // 250 / 100 batch limit = 3 calls
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it("embedBatch() throws when returned count != input count", async () => {
    global.fetch = makeFetchMock({
      body: { data: [{ embedding: Array(1536).fill(0), index: 0 }] },
    }) as unknown as typeof fetch;

    const p = createOpenAIProvider(TEST_KEY);
    await expect(p.embedBatch(["a", "b"])).rejects.toThrow(/returned 1 vectors for 2 inputs/);
  });
});
