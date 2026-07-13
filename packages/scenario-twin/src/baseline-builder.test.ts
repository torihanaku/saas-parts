/**
 * Tests for baseline-builder.ts (ported from 実運用SaaS
 * tests/twin-baseline.test.ts). Store is injected as a fake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { buildBaseline, __testing } from "./baseline-builder.js";
import type { TwinStore, BaselineToStore } from "./store.js";

const loadBaselineInputs = vi.fn();
const insertBaseline = vi.fn();

const store = {
  loadBaselineInputs,
  insertBaseline,
} as unknown as TwinStore;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildBaseline", () => {
  it("builds metrics from drafts + insights and persists them", async () => {
    loadBaselineInputs.mockResolvedValueOnce({
      drafts: [
        { type: "article", created_at: "2026-05-01T00:00:00Z" },
        { type: "email", created_at: "2026-05-01T00:00:00Z" },
      ],
      insights: [
        { date: "2026-05-01", spend_jpy: 100, impressions: 1000, conversions: 10 },
      ],
    });
    insertBaseline.mockResolvedValueOnce("baseline-1");

    const id = await buildBaseline("t1", store, 90);
    expect(id).toBe("baseline-1");
    const row = insertBaseline.mock.calls[0]![0] as BaselineToStore;
    expect(row.metrics.blog_count!.mean).toBe(1);
    expect(row.metrics.ad_budget!.mean).toBe(100);
    expect(row.windowDays).toBe(90);
  });

  it("throws insufficient_baseline_data when there is no history", async () => {
    loadBaselineInputs.mockResolvedValueOnce({ drafts: [], insights: [] });
    await expect(buildBaseline("t1", store)).rejects.toThrow(
      "insufficient_baseline_data",
    );
  });
});

describe("__testing.stats", () => {
  it("computes mean and std", () => {
    const { mean, std } = __testing.stats([2, 4, 6]);
    expect(mean).toBe(4);
    expect(std).toBeCloseTo(1.63, 1);
  });

  it("returns zeros for empty input", () => {
    expect(__testing.stats([])).toEqual({ mean: 0, std: 0 });
  });
});

describe("__testing.toNumber", () => {
  it("parses numeric strings and defaults to 0", () => {
    expect(__testing.toNumber("42")).toBe(42);
    expect(__testing.toNumber("nope")).toBe(0);
    expect(__testing.toNumber(null)).toBe(0);
  });
});
