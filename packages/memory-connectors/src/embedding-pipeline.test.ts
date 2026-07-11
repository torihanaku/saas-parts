/**
 * Tests for embedding-pipeline.ts. Embedder + cost ledger are injected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  embedMemoryText,
  estimateTokens,
  estimateCostJpy,
  currentYearMonth,
  assertWithinBudget,
  EmbeddingBudgetExceededError,
  MONTHLY_LIMIT_JPY,
  type EmbeddingCostLedger,
} from "./embedding-pipeline.js";

const embed = vi.fn();
const getMonthly = vi.fn();
const charge = vi.fn();

const ledger: EmbeddingCostLedger = { getMonthly, charge };

beforeEach(() => {
  vi.clearAllMocks();
  embed.mockResolvedValue([0.1, 0.2, 0.3]);
  getMonthly.mockResolvedValue({ tokens: 0, jpy: 0, calls: 0 });
  charge.mockResolvedValue(0.5);
});

describe("pure helpers", () => {
  it("estimates ~1 token per 4 chars", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("estimates cost as a positive small number", () => {
    expect(estimateCostJpy(1_000_000)).toBeCloseTo((0.02 * 160), 5);
  });

  it("formats a UTC year-month", () => {
    expect(currentYearMonth(new Date("2026-07-11T00:00:00Z"))).toBe("2026-07");
  });
});

describe("assertWithinBudget", () => {
  it("throws when projected total exceeds the cap", async () => {
    getMonthly.mockResolvedValueOnce({ tokens: 0, jpy: MONTHLY_LIMIT_JPY - 1, calls: 0 });
    await expect(
      assertWithinBudget("t1", 100, ledger, "2026-07"),
    ).rejects.toBeInstanceOf(EmbeddingBudgetExceededError);
  });

  it("returns remaining budget when within cap", async () => {
    const { remainingJpy } = await assertWithinBudget("t1", 100, ledger, "2026-07");
    expect(remainingJpy).toBe(MONTHLY_LIMIT_JPY - 100);
  });
});

describe("embedMemoryText", () => {
  it("embeds, charges, and returns the result", async () => {
    charge.mockResolvedValueOnce(1.5);
    const res = await embedMemoryText("t1", "some text here", { embed, ledger });
    expect(res.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(res.tokensUsed).toBeGreaterThan(0);
    expect(res.monthlyTotalJpy).toBe(1.5);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("throws over budget before calling the embedder", async () => {
    getMonthly.mockResolvedValueOnce({ tokens: 0, jpy: MONTHLY_LIMIT_JPY, calls: 0 });
    await expect(
      embedMemoryText("t1", "a".repeat(400), { embed, ledger }),
    ).rejects.toBeInstanceOf(EmbeddingBudgetExceededError);
    expect(embed).not.toHaveBeenCalled();
  });

  it("skips the budget check when skipBudgetCheck is set", async () => {
    const res = await embedMemoryText("t1", "x", { embed, ledger }, { skipBudgetCheck: true });
    expect(res.embedding).toBeDefined();
    expect(getMonthly).not.toHaveBeenCalled();
  });

  it("keeps the embedding usable when charging throws", async () => {
    charge.mockRejectedValueOnce(new Error("db down"));
    const res = await embedMemoryText("t1", "text", { embed, ledger });
    expect(res.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(res.monthlyTotalJpy).toBe(0);
  });

  it("validates inputs", async () => {
    await expect(embedMemoryText("", "x", { embed, ledger })).rejects.toThrow(/tenantId/);
    await expect(embedMemoryText("t1", "  ", { embed, ledger })).rejects.toThrow(/text/);
  });
});
