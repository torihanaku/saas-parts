import { describe, it, expect, vi } from "vitest";
import { sanitizeRoiPrediction, predictRoi } from "./roi-predictor";
import type { LlmClient } from "./llm";

describe("sanitizeRoiPrediction", () => {
  it("clamps NaN / non-finite to 0", () => {
    const r = sanitizeRoiPrediction({ predictedRoi: NaN, predictedRevenueJpy: Infinity, confidenceLow: NaN, confidenceHigh: NaN });
    expect(r.predictedRoi).toBe(0);
    expect(r.predictedRevenueJpy).toBe(0);
    expect(r.confidenceLow).toBe(0);
    expect(r.confidenceHigh).toBe(0);
  });

  it("clamps ROI to [0,10]", () => {
    expect(sanitizeRoiPrediction({ predictedRoi: 25 }).predictedRoi).toBe(10);
    expect(sanitizeRoiPrediction({ predictedRoi: -3 }).predictedRoi).toBe(0);
  });

  it("swaps inverted confidence bounds", () => {
    const r = sanitizeRoiPrediction({ confidenceLow: 4, confidenceHigh: 1 });
    expect(r.confidenceLow).toBe(1);
    expect(r.confidenceHigh).toBe(4);
  });

  it("provides placeholder reasoning when empty", () => {
    expect(sanitizeRoiPrediction({ reasoning: "  " }).reasoning).toBe("(reasoning unavailable)");
  });
});

describe("predictRoi", () => {
  it("sanitizes the LLM output", async () => {
    const llm: LlmClient = {
      generateJson: vi.fn().mockResolvedValue({ predictedRoi: 99, predictedRevenueJpy: -5, confidenceLow: 3, confidenceHigh: 1, reasoning: "good" }),
      generateText: vi.fn(),
    };
    const out = await predictRoi(llm, { campaignName: "n", channel: "google", budgetJpy: 100_000, durationDays: 14, tenantId: "t" });
    expect(out.predictedRoi).toBe(10);
    expect(out.predictedRevenueJpy).toBe(0);
    expect(out.confidenceLow).toBe(1);
    expect(out.confidenceHigh).toBe(3);
    expect(llm.generateJson).toHaveBeenCalled();
  });
});
