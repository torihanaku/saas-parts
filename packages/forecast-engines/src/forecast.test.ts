/**
 * Ported from 実運用SaaS `tests/marketing-forecast.test.ts` and
 * `tests/prophet-engine.test.ts` (with `vi` imported explicitly), plus
 * golden tests: fixed input series → exact expected outputs within tolerance.
 */
import { describe, it, expect, vi } from "vitest";
import { defaultEngineSelector } from "./engine-selector";
import { arimaEngine } from "./arima-engine";
import { movingAverageEngine } from "./moving-average-engine";
import { ProphetEngine } from "./prophet-engine";
import { arLeastSquareDegree1, populationStdev } from "./ar-least-square";

describe("engine-selector", () => {
  it("should return null if availableDays < 30", () => {
    expect(defaultEngineSelector.pickEngine(29)).toBeNull();
  });

  it("should return movingAverageEngine if 30 <= availableDays < 90", () => {
    expect(defaultEngineSelector.pickEngine(30)).toBe(movingAverageEngine);
    expect(defaultEngineSelector.pickEngine(89)).toBe(movingAverageEngine);
  });

  it("should return arimaEngine if availableDays >= 90 and < 180", () => {
    expect(defaultEngineSelector.pickEngine(90)).toBe(arimaEngine);
    expect(defaultEngineSelector.pickEngine(179)).toBe(arimaEngine);
  });

  it("should return ProphetEngine if availableDays >= 180", () => {
    const prophet = defaultEngineSelector.pickEngine(365);
    expect(prophet?.name).toBe('seasonal_regression');
  });
});

describe("movingAverageEngine", () => {
  it("should generate a stable forecast with mean", async () => {
    const series = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value: 100 + (i % 2 === 0 ? 10 : -10) // oscillates around 100
    }));

    const result = await movingAverageEngine.forecast({
      series,
      horizonDays: 7,
      confidenceLevel: 0.95
    });

    expect(result.method).toBe("moving_average");
    expect(result.forecast).toHaveLength(7);
    expect(result.forecast[0]).toBe(100);
    expect(result.forecast[6]).toBe(100);
    expect(result.confidenceUpper[0]).toBeGreaterThan(100);
    expect(result.confidenceLower[0]).toBeLessThan(100);
    // Uncertainty should grow
    expect(result.confidenceUpper[6]).toBeGreaterThan(result.confidenceUpper[0]!);
  });

  it("should throw if data length < minDays", async () => {
    await expect(movingAverageEngine.forecast({ series: [], horizonDays: 7 }))
      .rejects.toThrow("Insufficient data for moving_average");
  });

  it("golden: mean=100, std=10 → CI margins of z·std·sqrt(i)", async () => {
    const series = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value: i % 2 === 0 ? 110 : 90,
    }));

    const result = await movingAverageEngine.forecast({ series, horizonDays: 7 });

    // margin(i) = 1.96 * 10 * sqrt(i)
    expect(result.confidenceUpper[0]).toBeCloseTo(100 + 1.96 * 10, 10);
    expect(result.confidenceLower[0]).toBeCloseTo(100 - 1.96 * 10, 10);
    expect(result.confidenceUpper[6]).toBeCloseTo(100 + 1.96 * 10 * Math.sqrt(7), 10);
  });
});

describe("arimaEngine", () => {
  it("should capture a simple trend", async () => {
    const series = Array.from({ length: 90 }, (_, i) => ({
      date: new Date(2026, 0, i + 1).toISOString().split('T')[0]!,
      value: 100 + i // steady increase
    }));

    const result = await arimaEngine.forecast({
      series,
      horizonDays: 7
    });

    expect(result.method).toBe("arima");
    expect(result.forecast).toHaveLength(7);
    // Should continue increasing
    expect(result.forecast[0]).toBeGreaterThan(189);
    expect(result.forecast[6]).toBeGreaterThan(result.forecast[0]!);
  });

  it("should warn if data length is below recommended minDays", async () => {
    const series = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value: 100
    }));
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await arimaEngine.forecast({ series, horizonDays: 7 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("should throw if data points < 7", async () => {
    await expect(arimaEngine.forecast({ series: [], horizonDays: 7 }))
      .rejects.toThrow("ARIMA requires at least 7 data points");
  });

  it("golden: perfectly linear series → AR coeff 1, exact continuation, zero margin", async () => {
    // values 100..189 → all diffs = 1 → coeff = 1, stdev(diffs) = 0.
    const series = Array.from({ length: 90 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      value: 100 + i,
    }));

    const result = await arimaEngine.forecast({ series, horizonDays: 7 });

    expect(result.forecast).toEqual([190, 191, 192, 193, 194, 195, 196]);
    expect(result.confidenceLower).toEqual(result.forecast);
    expect(result.confidenceUpper).toEqual(result.forecast);
    expect(result.reason).toContain("AR coeff: 1.000");
  });
});

describe("ar-least-square primitives", () => {
  it("golden: lag-1 coefficient = Σv[i+1]·v[i] / Σv[i]²", () => {
    // values [1, 2, 3, 4]: num = 1·2 + 2·3 + 3·4 = 20, den = 1 + 4 + 9 = 14.
    expect(arLeastSquareDegree1([1, 2, 3, 4])).toBeCloseTo(20 / 14, 12);
    // Constant series → coefficient exactly 1.
    expect(arLeastSquareDegree1([5, 5, 5, 5])).toBeCloseTo(1, 12);
    // All-zero series → NaN (caller falls back to 0 via `|| 0`).
    expect(arLeastSquareDegree1([0, 0, 0])).toBeNaN();
  });

  it("golden: population stdev divides by n", () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → mean 5, variance 4, stdev 2.
    expect(populationStdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 12);
    expect(populationStdev([3, 3, 3])).toBe(0);
  });
});

describe("Seasonal Regression Engine", () => {
  const engine = new ProphetEngine();

  it("throws if not enough days", async () => {
    await expect(engine.forecast({ series: [], horizonDays: 7 })).rejects.toThrow(/Seasonal regression requires at least/);
  });

  it("forecasts using trend, weekly seasonality, and autoregressive residuals", async () => {
    const series = Array.from({ length: 90 }).map((_, i) => ({
      date: new Date(Date.now() - (90 - i) * 86400000).toISOString(),
      value: 100 + (i % 7) * 10
    }));

    const res = await engine.forecast({ series, horizonDays: 7 });
    expect(res.method).toBe('seasonal_regression');
    expect(res.forecast).toHaveLength(7);
    expect(res.confidenceLower).toHaveLength(7);
    expect(res.confidenceUpper).toHaveLength(7);

    // Costs can't be negative
    expect(res.forecast.every(v => v >= 0)).toBe(true);
  });

  it("golden: pure linear trend is extrapolated exactly with zero-width CI", async () => {
    // value = 5 + 2·i → residuals 0, seasonality 0 → forecast(x) = 5 + 2·x.
    const series = Array.from({ length: 90 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
      value: 5 + 2 * i,
    }));

    const res = await engine.forecast({ series, horizonDays: 7 });

    for (let i = 0; i < 7; i++) {
      const expected = 5 + 2 * (90 + i); // 185, 187, ..., 197
      expect(res.forecast[i]).toBeCloseTo(expected, 8);
      expect(res.confidenceLower[i]).toBeCloseTo(expected, 8);
      expect(res.confidenceUpper[i]).toBeCloseTo(expected, 8);
    }
  });
});
