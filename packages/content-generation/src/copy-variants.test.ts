import { describe, it, expect, vi } from "vitest";
import { generateCopyVariants, COPY_VARIANT_LIMITS, type CopyVariant } from "./copy-variants.js";
import type { GenerateJson } from "./types.js";

const makeVariants = (n: number): CopyVariant[] =>
  Array.from({ length: n }, (_, i) => ({
    headline: `見出し${i + 1}`,
    body: `本文${i + 1}`,
    cta: `CTA${i + 1}`,
  }));

/** variants を返す GenerateJson フェイク。 */
function jsonReturning(value: unknown): { fn: GenerateJson; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const fn = (async (system: string, user: string) => {
    calls.push([system, user]);
    return value;
  }) as unknown as GenerateJson;
  return { fn, calls };
}

describe("generateCopyVariants", () => {
  it("throws on empty promptText", async () => {
    const { fn } = jsonReturning({ variants: [] });
    await expect(generateCopyVariants(fn, { promptText: "   " })).rejects.toThrow(/promptText/);
  });

  it("returns fallback when LLM is missing", async () => {
    const out = await generateCopyVariants(undefined, { promptText: "新規 SaaS の LP コピー" });
    expect(out.source).toBe("fallback");
    expect(out.variants).toHaveLength(COPY_VARIANT_LIMITS.DEFAULT);
  });

  it("returns AI variants on success (default count)", async () => {
    const { fn } = jsonReturning({ variants: makeVariants(3) });
    const out = await generateCopyVariants(fn, { promptText: "営業向けバナー" });
    expect(out.source).toBe("ai");
    expect(out.variants).toHaveLength(3);
    expect(out.variants[0]!.headline).toBe("見出し1");
    expect(out.variants[0]!.cta).toBe("CTA1");
  });

  it("clamps count above MAX", async () => {
    const { fn } = jsonReturning({ variants: makeVariants(5) });
    const out = await generateCopyVariants(fn, { promptText: "test", count: 99 });
    expect(out.variants).toHaveLength(COPY_VARIANT_LIMITS.MAX);
  });

  it("clamps count below MIN", async () => {
    const { fn } = jsonReturning({ variants: makeVariants(1) });
    const out = await generateCopyVariants(fn, { promptText: "test", count: 0 });
    expect(out.variants).toHaveLength(COPY_VARIANT_LIMITS.MIN);
  });

  it("pads with fallback when AI returns fewer variants than requested", async () => {
    const { fn } = jsonReturning({ variants: makeVariants(1) });
    const out = await generateCopyVariants(fn, { promptText: "test", count: 3 });
    expect(out.source).toBe("ai");
    expect(out.variants).toHaveLength(3);
    expect(out.variants[0]!.headline).toBe("見出し1");
    expect(out.variants[2]!.cta).toBe("詳細を見る");
  });

  it("returns fallback when AI returns no valid variants", async () => {
    const { fn } = jsonReturning({ variants: [{ headline: "" }] });
    const out = await generateCopyVariants(fn, { promptText: "test" });
    expect(out.source).toBe("fallback");
    expect(out.variants).toHaveLength(COPY_VARIANT_LIMITS.DEFAULT);
  });

  it("returns fallback when AI throws", async () => {
    const fn = (async () => {
      throw new Error("rate limited");
    }) as unknown as GenerateJson;
    const out = await generateCopyVariants(fn, { promptText: "test" });
    expect(out.source).toBe("fallback");
    expect(out.variants).toHaveLength(COPY_VARIANT_LIMITS.DEFAULT);
  });

  it("filters out variants missing required fields", async () => {
    const { fn } = jsonReturning({
      variants: [
        { headline: "ok", body: "b", cta: "c" },
        { headline: "no-body", cta: "c" },
        { headline: "ok2", body: "b2", cta: "c2" },
      ],
    });
    const out = await generateCopyVariants(fn, { promptText: "test", count: 3 });
    expect(out.source).toBe("ai");
    expect(out.variants[0]!.headline).toBe("ok");
    expect(out.variants[1]!.headline).toBe("ok2");
    expect(out.variants[2]!.cta).toBe("詳細を見る");
  });

  it("passes brandVoiceContext into the system prompt", async () => {
    const { fn, calls } = jsonReturning({ variants: makeVariants(3) });
    await generateCopyVariants(fn, { promptText: "test", brandVoiceContext: "誇張禁止、 数値根拠必須" });
    expect(calls[0]![0]).toContain("誇張禁止");
  });
});
