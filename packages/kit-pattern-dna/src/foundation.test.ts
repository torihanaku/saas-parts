/**
 * 出典テスト: dev-dashboard-v2 tests/company-dna.test.ts（コア部分を移植）。
 * Supabase モック → InMemoryDnaStore に置き換え。
 */
import { describe, it, expect } from "vitest";
import {
  clampConfidence,
  clampInt,
  getDnaByType,
  getDnaStats,
  ingestDna,
  validateIngestRequest,
} from "./foundation.js";
import { InMemoryDnaStore } from "./stores.js";
import { PATTERN_DNA_TYPES, isPatternDnaType } from "./types.js";

const TENANT = "tenant-1";

describe("types — isPatternDnaType", () => {
  it("accepts all 5 canonical types and rejects unknowns", () => {
    for (const t of PATTERN_DNA_TYPES) expect(isPatternDnaType(t)).toBe(true);
    expect(isPatternDnaType("unknown")).toBe(false);
    expect(isPatternDnaType(42)).toBe(false);
    expect(isPatternDnaType(undefined)).toBe(false);
  });
});

describe("clampConfidence", () => {
  it("clamps to [0, 1] and falls back to 1 for non-finite", () => {
    expect(clampConfidence(0.5)).toBe(0.5);
    expect(clampConfidence(-1)).toBe(0);
    expect(clampConfidence(2)).toBe(1);
    expect(clampConfidence("0.25")).toBe(0.25);
    expect(clampConfidence(NaN)).toBe(1);
    expect(clampConfidence("abc")).toBe(1);
  });
});

describe("clampInt", () => {
  it("clamps into range and floors", () => {
    expect(clampInt(3.9, 1, 10, 5)).toBe(3);
    expect(clampInt(0, 1, 10, 5)).toBe(1);
    expect(clampInt(99, 1, 10, 5)).toBe(10);
    expect(clampInt("x", 1, 10, 5)).toBe(5);
  });
});

describe("validateIngestRequest", () => {
  const valid = {
    dna_type: "content" as const,
    key: " k1 ",
    value: { a: 1 },
    source: " manual ",
  };

  it("normalises a valid payload (trim + default confidence=1)", () => {
    const res = validateIngestRequest(valid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.key).toBe("k1");
    expect(res.value.source).toBe("manual");
    expect(res.value.confidence).toBe(1);
  });

  it("rejects unknown dna_type", () => {
    const res = validateIngestRequest({ ...valid, dna_type: "bogus" as never });
    expect(res).toEqual({ ok: false, error: "invalid_dna_type" });
  });

  it("rejects empty key / value / source", () => {
    expect(validateIngestRequest({ ...valid, key: "  " })).toEqual({
      ok: false,
      error: "key_required",
    });
    expect(validateIngestRequest({ ...valid, value: undefined })).toEqual({
      ok: false,
      error: "value_required",
    });
    expect(validateIngestRequest({ ...valid, source: "" })).toEqual({
      ok: false,
      error: "source_required",
    });
  });

  it("rejects out-of-range confidence but accepts boundary values", () => {
    expect(validateIngestRequest({ ...valid, confidence: 1.5 })).toEqual({
      ok: false,
      error: "confidence_out_of_range",
    });
    expect(validateIngestRequest({ ...valid, confidence: -0.1 })).toEqual({
      ok: false,
      error: "confidence_out_of_range",
    });
    const ok = validateIngestRequest({ ...valid, confidence: 0 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.confidence).toBe(0);
  });
});

describe("ingestDna — upsert semantics", () => {
  it("inserts a fresh row then updates in place on the same composite key", async () => {
    const store = new InMemoryDnaStore();
    const first = await ingestDna(store, {
      tenantId: TENANT,
      dnaType: "glossary",
      key: "term-1",
      value: { text: "v1" },
      source: "manual",
      confidence: 0.8,
    });
    expect(first).not.toBeNull();
    expect(first!.createdAt).toBe(first!.updatedAt);

    const second = await ingestDna(store, {
      tenantId: TENANT,
      dnaType: "glossary",
      key: "term-1",
      value: { text: "v2" },
      source: "scrape:blog",
      confidence: 0.9,
    });
    expect(second).not.toBeNull();
    expect(second!.value).toEqual({ text: "v2" });
    expect(second!.source).toBe("scrape:blog");
    expect(second!.createdAt).toBe(first!.createdAt); // createdAt preserved

    expect(await store.count(TENANT, "glossary")).toBe(1); // upsert, no duplicate
  });

  it("returns null when the store throws", async () => {
    const failing = new InMemoryDnaStore();
    failing.upsert = async () => {
      throw new Error("db down");
    };
    const row = await ingestDna(failing, {
      tenantId: TENANT,
      dnaType: "content",
      key: "k",
      value: {},
      source: "manual",
      confidence: 1,
    });
    expect(row).toBeNull();
  });
});

describe("getDnaByType — pagination", () => {
  it("returns windowed rows with total count and clamps limit", async () => {
    const store = new InMemoryDnaStore();
    for (let i = 0; i < 7; i++) {
      await store.upsert({
        tenantId: TENANT,
        dnaType: "content",
        key: `k-${i}`,
        value: {},
        source: "manual",
        confidence: 1,
      });
    }
    // 別タイプ・別テナントは混ざらない
    await store.upsert({
      tenantId: TENANT,
      dnaType: "seasonal",
      key: "other",
      value: {},
      source: "manual",
      confidence: 1,
    });
    await store.upsert({
      tenantId: "tenant-2",
      dnaType: "content",
      key: "foreign",
      value: {},
      source: "manual",
      confidence: 1,
    });

    const page = await getDnaByType(store, {
      tenantId: TENANT,
      dnaType: "content",
      limit: 3,
      offset: 5,
    });
    expect(page.total).toBe(7);
    expect(page.rows.length).toBe(2);
    expect(page.limit).toBe(3);
    expect(page.offset).toBe(5);

    const clamped = await getDnaByType(store, {
      tenantId: TENANT,
      dnaType: "content",
      limit: 9999,
      offset: -3,
    });
    expect(clamped.limit).toBe(500);
    expect(clamped.offset).toBe(0);
    expect(clamped.rows.length).toBe(7);
  });
});

describe("getDnaStats", () => {
  it("returns zeroed stats for an empty tenant", async () => {
    const store = new InMemoryDnaStore();
    const stats = await getDnaStats(store, TENANT);
    expect(stats.total).toBe(0);
    expect(stats.meanConfidence).toBe(0);
    for (const t of PATTERN_DNA_TYPES) expect(stats.byType[t]).toBe(0);
  });

  it("aggregates counts per type and mean confidence", async () => {
    const store = new InMemoryDnaStore();
    await store.upsert({
      tenantId: TENANT, dnaType: "content", key: "a", value: {}, source: "m", confidence: 1,
    });
    await store.upsert({
      tenantId: TENANT, dnaType: "content", key: "b", value: {}, source: "m", confidence: 0.5,
    });
    await store.upsert({
      tenantId: TENANT, dnaType: "glossary", key: "c", value: {}, source: "m", confidence: 0.9,
    });

    const stats = await getDnaStats(store, TENANT);
    expect(stats.total).toBe(3);
    expect(stats.byType.content).toBe(2);
    expect(stats.byType.glossary).toBe(1);
    expect(stats.byType.seasonal).toBe(0);
    expect(stats.meanConfidence).toBeCloseTo((1 + 0.5 + 0.9) / 3, 10);
  });
});
