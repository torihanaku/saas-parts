import { describe, it, expect } from "vitest";
import {
  sampleBeta,
  thompsonAllocate,
  posteriorBestProbability,
  uniformAllocate,
  BANDIT_DEFAULTS,
  type BetaVariant,
} from "./index";

/** Mulberry32 — シード付き決定的PRNG（テスト専用）。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("sampleBeta", () => {
  it("returns values in (0, 1)", () => {
    const rng = makeRng(1);
    for (let i = 0; i < 500; i++) {
      const s = sampleBeta(2, 5, rng);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    }
  });

  it("is deterministic for a fixed seed (golden)", () => {
    const a = sampleBeta(3, 7, makeRng(42));
    const b = sampleBeta(3, 7, makeRng(42));
    expect(a).toBe(b);
    // Golden value: locked in from the first run with mulberry32(42).
    expect(a).toMatchInlineSnapshot(`0.15168129796588087`);
  });

  it("concentrates around alpha/(alpha+beta) for large parameters", () => {
    const rng = makeRng(7);
    let sum = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) sum += sampleBeta(80, 20, rng);
    expect(sum / n).toBeCloseTo(0.8, 1);
  });

  it("handles shape < 1 (boost path)", () => {
    const rng = makeRng(9);
    const s = sampleBeta(0.5, 0.5, rng);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it("throws on non-positive parameters", () => {
    expect(() => sampleBeta(0, 1, makeRng(1))).toThrow();
    expect(() => sampleBeta(1, -1, makeRng(1))).toThrow();
  });
});

describe("thompsonAllocate", () => {
  const variants: BetaVariant[] = [
    { id: "a", alpha: 10, beta: 90 }, // ~10% CVR
    { id: "b", alpha: 50, beta: 50 }, // ~50% CVR
  ];

  it("throws on empty variants", () => {
    expect(() => thompsonAllocate([], makeRng(1))).toThrow("no variants");
  });

  it("is deterministic for a fixed seed", () => {
    const r1 = thompsonAllocate(variants, makeRng(123));
    const r2 = thompsonAllocate(variants, makeRng(123));
    expect(r1).toEqual(r2);
    expect(r1.source).toBe("thompson");
  });

  it("mostly picks the clearly better variant", () => {
    const rng = makeRng(5);
    let bWins = 0;
    for (let i = 0; i < 200; i++) {
      if (thompsonAllocate(variants, rng).variantId === "b") bWins++;
    }
    expect(bWins).toBeGreaterThan(180);
  });

  it("returns the sampled posterior as probability", () => {
    const r = thompsonAllocate(variants, makeRng(1));
    expect(r.probability).toBeGreaterThan(0);
    expect(r.probability).toBeLessThan(1);
  });
});

describe("posteriorBestProbability", () => {
  it("returns 1/0 for a single variant depending on target", () => {
    const only: BetaVariant[] = [{ id: "solo", alpha: 1, beta: 1 }];
    expect(posteriorBestProbability(only, "solo", 10, makeRng(1))).toBe(1);
    expect(posteriorBestProbability(only, "other", 10, makeRng(1))).toBe(0);
  });

  it("gives near-certain probability to a dominant variant", () => {
    const variants: BetaVariant[] = [
      { id: "weak", alpha: 5, beta: 95 },
      { id: "strong", alpha: 95, beta: 5 },
    ];
    const p = posteriorBestProbability(variants, "strong", 500, makeRng(11));
    expect(p).toBeGreaterThan(0.99);
    const q = posteriorBestProbability(variants, "weak", 500, makeRng(11));
    expect(q).toBeLessThan(0.01);
  });

  it("gives ~0.5 for symmetric variants", () => {
    const variants: BetaVariant[] = [
      { id: "x", alpha: 30, beta: 30 },
      { id: "y", alpha: 30, beta: 30 },
    ];
    const p = posteriorBestProbability(variants, "x", 2000, makeRng(3));
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.6);
  });

  it("uses BANDIT_DEFAULTS.POSTERIOR_DRAWS = 2000 as default", () => {
    expect(BANDIT_DEFAULTS.POSTERIOR_DRAWS).toBe(2000);
  });
});

describe("uniformAllocate", () => {
  it("throws on empty variants", () => {
    expect(() => uniformAllocate([], makeRng(1))).toThrow("no variants");
  });

  it("picks by uniform index and reports 1/n probability", () => {
    const variants = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const r = uniformAllocate(variants, () => 0.6); // floor(0.6*4)=2 -> "c"
    expect(r).toEqual({ variantId: "c", source: "epsilon_greedy", probability: 0.25 });
  });

  it("covers all variants over many draws", () => {
    const variants = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const rng = makeRng(21);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(uniformAllocate(variants, rng).variantId);
    expect(seen.size).toBe(3);
  });
});
