import type { ForecastEngine, ForecastParams, ForecastResult } from "./forecast-engine";

/**
 * Simple Moving Average (SMA) based forecast (for 30-90 days of data).
 * Provides a stable baseline with wider confidence intervals.
 *
 * Ported verbatim from 実運用SaaS `server/lib/forecast/moving-average-engine.ts`.
 */
export const movingAverageEngine: ForecastEngine = {
  name: 'moving_average',
  minDays: 30,
  async forecast(params: ForecastParams): Promise<ForecastResult> {
    const { series, horizonDays, confidenceLevel = 0.95 } = params;

    if (series.length < this.minDays) {
      throw new Error(`Insufficient data for moving_average: required ${this.minDays}, got ${series.length}`);
    }

    const values = series.map(p => p.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    // Calculate standard deviation for confidence intervals
    const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
    const std = Math.sqrt(variance);

    // Z-score for confidence level (approximate)
    // 0.95 -> 1.96, 0.90 -> 1.645, 0.99 -> 2.576
    let z = 1.96;
    if (confidenceLevel >= 0.99) z = 2.576;
    else if (confidenceLevel <= 0.90) z = 1.645;

    const forecast: number[] = [];
    const lower: number[] = [];
    const upper: number[] = [];

    for (let i = 1; i <= horizonDays; i++) {
      forecast.push(mean);

      // Uncertainty grows with time (random walk style)
      const margin = z * std * Math.sqrt(i);
      lower.push(Math.max(0, mean - margin));
      upper.push(mean + margin);
    }

    return {
      forecast,
      confidenceLower: lower,
      confidenceUpper: upper,
      confidenceLevel,
      method: 'moving_average',
      reason: `Simple Moving Average based on ${series.length} days of history.`
    };
  },
};
