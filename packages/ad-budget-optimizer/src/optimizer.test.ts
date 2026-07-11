import { describe, it, expect, vi } from "vitest";
import { generateForecast, generateOptimization } from "./optimizer";
import type { LlmClient } from "./llm";

function makeLlm(): LlmClient {
  return {
    generateJson: vi.fn(async (_s, _u, fallback) => fallback),
    generateText: vi.fn(async () => "narrative"),
  };
}

describe("generateForecast", () => {
  it("returns a data-insufficient fallback for <7 points", async () => {
    const llm = makeLlm();
    const r = await generateForecast(llm, [{ date: "2026-01-01", cost: 10 }]);
    expect(r.forecast).toHaveLength(0);
    expect(r.narrative).toContain("データ不足");
    expect(llm.generateText).not.toHaveBeenCalled();
  });

  it("produces a 30-day forecast + narrative for sufficient data", async () => {
    const llm = makeLlm();
    const history = Array.from({ length: 14 }, (_, i) => ({
      date: new Date(2026, 0, i + 1).toISOString().slice(0, 10),
      cost: 100 + i * 5,
    }));
    const r = await generateForecast(llm, history);
    expect(r.forecast).toHaveLength(30);
    expect(["increasing", "decreasing", "stable"]).toContain(r.trend);
    expect(r.narrative).toBe("narrative");
    // CI bounds must bracket the point estimate
    for (const f of r.forecast) {
      expect(f.lower).toBeLessThanOrEqual(f.cost);
      expect(f.upper).toBeGreaterThanOrEqual(f.cost);
    }
  });
});

describe("generateOptimization", () => {
  it("returns the fallback when the LLM yields nothing", async () => {
    const llm = makeLlm();
    const r = await generateOptimization(llm, { compute: 1000 });
    expect(r.recommendations).toEqual([]);
    expect(llm.generateJson).toHaveBeenCalled();
  });
});
