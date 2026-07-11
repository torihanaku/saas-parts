/**
 * Ported from dev-dashboard-v2 tests/embedding-client.test.ts.
 * The env-based primary selection test is adapted to setPrimaryProvider,
 * and guard tests are added for the injected consent hook.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerProvider,
  clearProviders,
  listProviders,
  getProvider,
  embedText,
  embedBatch,
  setPrimaryProvider,
  setEmbedGuard,
  EmbeddingProviderError,
  type EmbeddingProvider,
} from "./registry";

function makeFakeProvider(slug: string, dim: number, fixedValue = 0.1): EmbeddingProvider {
  return {
    slug,
    dimension: dim,
    maxInputTokens: 8000,
    embed: async (_text: string) => Array(dim).fill(fixedValue),
    embedBatch: async (texts: string[]) => texts.map(() => Array(dim).fill(fixedValue)),
  };
}

describe("embeddings registry", () => {
  beforeEach(() => {
    clearProviders();
    setPrimaryProvider(undefined);
    setEmbedGuard(null);
  });

  afterEach(() => {
    clearProviders();
    setPrimaryProvider(undefined);
    setEmbedGuard(null);
  });

  describe("registerProvider / listProviders", () => {
    it("registers and lists providers", () => {
      registerProvider(makeFakeProvider("p1", 1536));
      registerProvider(makeFakeProvider("p2", 1024));
      const list = listProviders();
      expect(list).toEqual([
        { slug: "p1", dimension: 1536 },
        { slug: "p2", dimension: 1024 },
      ]);
    });

    it("re-registering same slug overwrites", () => {
      registerProvider(makeFakeProvider("p1", 1536));
      registerProvider(makeFakeProvider("p1", 768));
      const list = listProviders();
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({ slug: "p1", dimension: 768 });
    });
  });

  describe("getProvider", () => {
    it("returns provider by explicit slug", () => {
      registerProvider(makeFakeProvider("openai-3-small", 1536));
      registerProvider(makeFakeProvider("bge-m3", 1024));
      expect(getProvider("bge-m3").dimension).toBe(1024);
    });

    it("falls back to default 'openai-3-small' when no slug and no primary set", () => {
      registerProvider(makeFakeProvider("openai-3-small", 1536));
      expect(getProvider().slug).toBe("openai-3-small");
    });

    it("uses setPrimaryProvider slug when no slug given (was EMBEDDING_PRIMARY_MODEL)", () => {
      registerProvider(makeFakeProvider("openai-3-small", 1536));
      registerProvider(makeFakeProvider("bge-m3", 1024));
      setPrimaryProvider("bge-m3");
      expect(getProvider().slug).toBe("bge-m3");
    });

    it("throws EmbeddingProviderError when slug not registered", () => {
      registerProvider(makeFakeProvider("openai-3-small", 1536));
      expect(() => getProvider("ghost-model")).toThrow(EmbeddingProviderError);
    });

    it("error message includes registered slugs for debuggability", () => {
      registerProvider(makeFakeProvider("p1", 1536));
      registerProvider(makeFakeProvider("p2", 1024));
      try {
        getProvider("missing");
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as Error).message).toContain("p1");
        expect((e as Error).message).toContain("p2");
        expect((e as Error).message).toContain("missing");
      }
    });

    it("error message says (none) when registry is empty", () => {
      try {
        getProvider("anything");
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as Error).message).toContain("(none)");
      }
    });
  });

  describe("embedText / embedBatch convenience", () => {
    it("embedText delegates to provider.embed", async () => {
      registerProvider(makeFakeProvider("openai-3-small", 4, 0.5));
      const vec = await embedText("hello");
      expect(vec).toEqual([0.5, 0.5, 0.5, 0.5]);
    });

    it("embedBatch delegates to provider.embedBatch and preserves order", async () => {
      registerProvider(makeFakeProvider("openai-3-small", 2, 0.3));
      const vecs = await embedBatch(["a", "b", "c"]);
      expect(vecs).toHaveLength(3);
      expect(vecs[0]).toEqual([0.3, 0.3]);
    });

    it("embedBatch with empty array returns empty array", async () => {
      registerProvider({
        slug: "openai-3-small",
        dimension: 4,
        maxInputTokens: 8000,
        embed: async () => [0, 0, 0, 0],
        embedBatch: async (texts) => texts.map(() => [0, 0, 0, 0]),
      });
      const vecs = await embedBatch([]);
      expect(vecs).toEqual([]);
    });

    it("embedText with explicit slug overrides default", async () => {
      registerProvider(makeFakeProvider("openai-3-small", 1536, 0.1));
      registerProvider(makeFakeProvider("bge-m3", 1024, 0.9));
      const vec = await embedText("hello", "bge-m3");
      expect(vec).toHaveLength(1024);
      expect(vec[0]).toBe(0.9);
    });
  });

  describe("embed guard (injected consent check)", () => {
    it("calls the guard with userId/tenantId/purpose when both ids present", async () => {
      registerProvider(makeFakeProvider("openai-3-small", 4));
      const guard = vi.fn().mockResolvedValue(undefined);
      setEmbedGuard(guard);
      await embedText("hello", undefined, { userId: "u1", tenantId: "t1" });
      expect(guard).toHaveBeenCalledWith({ userId: "u1", tenantId: "t1", purpose: "ai_learning" });
    });

    it("skips the guard when userId/tenantId are missing", async () => {
      registerProvider(makeFakeProvider("openai-3-small", 4));
      const guard = vi.fn();
      setEmbedGuard(guard);
      await embedText("hello");
      await embedBatch(["a"], undefined, { userId: "u1" });
      expect(guard).not.toHaveBeenCalled();
    });

    it("a throwing guard blocks the embed", async () => {
      const provider = makeFakeProvider("openai-3-small", 4);
      const embedSpy = vi.spyOn(provider, "embed");
      registerProvider(provider);
      setEmbedGuard(async () => { throw new Error("consent missing"); });
      await expect(
        embedText("hello", undefined, { userId: "u1", tenantId: "t1" }),
      ).rejects.toThrow("consent missing");
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it("custom purpose is passed through", async () => {
      registerProvider(makeFakeProvider("openai-3-small", 4));
      const guard = vi.fn().mockResolvedValue(undefined);
      setEmbedGuard(guard);
      await embedBatch(["a"], undefined, { userId: "u1", tenantId: "t1", purpose: "analytics" });
      expect(guard).toHaveBeenCalledWith({ userId: "u1", tenantId: "t1", purpose: "analytics" });
    });
  });

  describe("clearProviders", () => {
    it("removes all registered providers", () => {
      registerProvider(makeFakeProvider("p1", 1536));
      registerProvider(makeFakeProvider("p2", 1024));
      clearProviders();
      expect(listProviders()).toEqual([]);
    });
  });
});
