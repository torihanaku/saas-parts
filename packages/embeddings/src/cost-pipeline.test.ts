/**
 * Ported from 実運用SaaS server/__tests__/embedding-pipeline.test.ts,
 * with the Supabase mocks replaced by a fake EmbeddingCostStore and the
 * embed function injected directly (no vi.mock needed).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  estimateTokens,
  estimateCostJpy,
  currentYearMonth,
  createCostPipeline,
  EmbeddingBudgetExceededError,
  DEFAULT_MONTHLY_LIMIT_JPY,
  type EmbeddingCostStore,
  type MonthlyCostRow,
} from "./cost-pipeline";

let mockCostData: MonthlyCostRow | null = null;
let mockCostError: Error | null = null;
let mockIncrementReturn: MonthlyCostRow | null = null;
let mockIncrementError: Error | null = null;

const incrementSpy = vi.fn();

const fakeStore: EmbeddingCostStore = {
  async getMonthlyCost(_tenantId, _yearMonth) {
    if (mockCostError) throw mockCostError;
    return mockCostData;
  },
  async incrementCost(entry) {
    incrementSpy(entry);
    if (mockIncrementError) throw mockIncrementError;
    return mockIncrementReturn;
  },
};

const mockEmbed = vi.fn(async (_text: string, _slug?: string) => Array(1536).fill(0.01));

function makePipeline(overrides: Partial<Parameters<typeof createCostPipeline>[0]> = {}) {
  return createCostPipeline({
    store: fakeStore,
    embed: mockEmbed,
    logError: () => {},
    ...overrides,
  });
}

describe("embedding cost pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCostData = null;
    mockCostError = null;
    mockIncrementReturn = null;
    mockIncrementError = null;
  });

  describe("estimateTokens", () => {
    it("returns 0 for empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });

    it("ceils 4 chars to 1 token", () => {
      expect(estimateTokens("abc")).toBe(1); // 3 chars → 0.75 → 1
      expect(estimateTokens("abcd")).toBe(1); // 4 chars → 1
      expect(estimateTokens("abcde")).toBe(2); // 5 chars → 1.25 → 2
    });

    it("handles long Japanese mixed text", () => {
      const text = "意思決定の理由を記録する。" + "x".repeat(80);
      expect(estimateTokens(text)).toBeGreaterThan(20);
    });
  });

  describe("estimateCostJpy", () => {
    it("returns 0 for 0 tokens", () => {
      expect(estimateCostJpy(0)).toBe(0);
    });

    it("yields a positive sub-yen cost for small inputs", () => {
      const cost = estimateCostJpy(1_000);
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(1);
    });

    it("scales linearly with tokens", () => {
      const a = estimateCostJpy(1_000);
      const b = estimateCostJpy(10_000);
      expect(b).toBeCloseTo(a * 10, 6);
    });

    it("1M tokens costs roughly ¥3.20 at 160 JPY/USD ($0.02/1M)", () => {
      const cost = estimateCostJpy(1_000_000);
      // $0.02 × 160 = ¥3.20
      expect(cost).toBeCloseTo(3.2, 2);
    });
  });

  describe("currentYearMonth", () => {
    it("formats YYYY-MM in UTC", () => {
      expect(currentYearMonth(new Date("2026-05-05T12:34:56Z"))).toBe("2026-05");
    });

    it("zero-pads single-digit months", () => {
      expect(currentYearMonth(new Date("2026-01-15T00:00:00Z"))).toBe("2026-01");
      expect(currentYearMonth(new Date("2026-09-15T00:00:00Z"))).toBe("2026-09");
    });
  });

  describe("getMonthlyCost", () => {
    it("returns zeros when no row exists", async () => {
      mockCostData = null;
      const result = await makePipeline().getMonthlyCost("tenant-1", "2026-05");
      expect(result).toEqual({ tokens: 0, jpy: 0, calls: 0 });
    });

    it("returns the row's totals when present", async () => {
      mockCostData = { total_tokens: 12_345, total_cost_jpy: 12.5, call_count: 42 };
      const result = await makePipeline().getMonthlyCost("tenant-1", "2026-05");
      expect(result).toEqual({ tokens: 12_345, jpy: 12.5, calls: 42 });
    });

    it("returns zeros (and does not throw) on store error", async () => {
      mockCostError = new Error("connection refused");
      const logError = vi.fn();
      const result = await makePipeline({ logError }).getMonthlyCost("tenant-1", "2026-05");
      expect(result).toEqual({ tokens: 0, jpy: 0, calls: 0 });
      expect(logError).toHaveBeenCalled();
    });
  });

  describe("assertWithinBudget", () => {
    it("returns remainingJpy when under cap", async () => {
      mockCostData = { total_tokens: 0, total_cost_jpy: 1_000, call_count: 0 };
      const result = await makePipeline().assertWithinBudget("tenant-1", 100, "2026-05");
      expect(result.currentJpy).toBe(1_000);
      expect(result.remainingJpy).toBe(DEFAULT_MONTHLY_LIMIT_JPY - 1_100);
    });

    it("throws EmbeddingBudgetExceededError when projected total exceeds cap", async () => {
      mockCostData = { total_tokens: 0, total_cost_jpy: 4_950, call_count: 0 };
      await expect(
        makePipeline().assertWithinBudget("tenant-1", 100, "2026-05"),
      ).rejects.toBeInstanceOf(EmbeddingBudgetExceededError);
    });

    it("allows exactly hitting the cap", async () => {
      mockCostData = { total_tokens: 0, total_cost_jpy: 4_999, call_count: 0 };
      const result = await makePipeline().assertWithinBudget("tenant-1", 1, "2026-05");
      expect(result.remainingJpy).toBe(0);
    });

    it("honours a custom monthlyLimitJpy", async () => {
      mockCostData = { total_tokens: 0, total_cost_jpy: 90, call_count: 0 };
      const pipeline = makePipeline({ monthlyLimitJpy: 100 });
      await expect(
        pipeline.assertWithinBudget("tenant-1", 20, "2026-05"),
      ).rejects.toBeInstanceOf(EmbeddingBudgetExceededError);
    });
  });

  describe("embedMemoryText", () => {
    beforeEach(() => {
      mockIncrementReturn = { total_tokens: 1_000, total_cost_jpy: 0.0032, call_count: 1 };
    });

    it("rejects empty text", async () => {
      await expect(makePipeline().embedMemoryText("tenant-1", "")).rejects.toThrow(/text is required/);
    });

    it("rejects missing tenantId", async () => {
      await expect(makePipeline().embedMemoryText("", "hello")).rejects.toThrow(/tenantId is required/);
    });

    it("calls embed and returns embedding + cost info", async () => {
      const result = await makePipeline().embedMemoryText("tenant-1", "How did we decide on Vercel?", {
        skipBudgetCheck: true,
      });
      expect(result.embedding).toHaveLength(1536);
      expect(result.tokensUsed).toBeGreaterThan(0);
      expect(result.costJpy).toBeGreaterThan(0);
      expect(mockEmbed).toHaveBeenCalledTimes(1);
    });

    it("blocks the embed call when budget is exceeded", async () => {
      mockCostData = { total_tokens: 0, total_cost_jpy: DEFAULT_MONTHLY_LIMIT_JPY, call_count: 0 };
      await expect(
        makePipeline().embedMemoryText("tenant-1", "anything"),
      ).rejects.toBeInstanceOf(EmbeddingBudgetExceededError);
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it("charges via store.incrementCost after success", async () => {
      mockCostData = { total_tokens: 0, total_cost_jpy: 0, call_count: 0 };
      await makePipeline().embedMemoryText("tenant-1", "test text");
      expect(incrementSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-1",
          yearMonth: expect.stringMatching(/^\d{4}-\d{2}$/),
          provider: "openai-3-small",
        }),
      );
    });

    it("does not throw if cost charge fails (returns embedding anyway)", async () => {
      mockCostData = { total_tokens: 0, total_cost_jpy: 0, call_count: 0 };
      mockIncrementError = new Error("store down");
      const result = await makePipeline().embedMemoryText("tenant-1", "test text");
      expect(result.embedding).toHaveLength(1536);
      expect(result.monthlyTotalJpy).toBe(0);
    });

    it("passes the provider slug override to embed and to the ledger", async () => {
      mockCostData = { total_tokens: 0, total_cost_jpy: 0, call_count: 0 };
      await makePipeline().embedMemoryText("tenant-1", "test text", { provider: "bge-m3" });
      expect(mockEmbed).toHaveBeenCalledWith("test text", "bge-m3");
      expect(incrementSpy).toHaveBeenCalledWith(expect.objectContaining({ provider: "bge-m3" }));
    });
  });

  describe("EmbeddingBudgetExceededError", () => {
    it("preserves tenant / period / amounts on the instance", () => {
      const err = new EmbeddingBudgetExceededError("t1", "2026-05", 5_100, 5_000);
      expect(err.tenantId).toBe("t1");
      expect(err.yearMonth).toBe("2026-05");
      expect(err.currentJpy).toBe(5_100);
      expect(err.limitJpy).toBe(5_000);
      expect(err.message).toContain("5000");
    });
  });
});
