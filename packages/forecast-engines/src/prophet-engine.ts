import type { ForecastEngine, ForecastParams, ForecastResult } from "./forecast-engine";

/**
 * Seasonal regression engine for long marketing series.
 *
 * The original roadmap mentioned Prophet, but this is a fully self-contained
 * TypeScript approximation — no Python/R sidecar and no external prophet
 * library. It fits a linear trend, learns day-of-week residual seasonality
 * from the historical series, and carries a decaying autoregressive residual
 * into the horizon.
 *
 * Ported verbatim from 実運用SaaS `server/lib/forecast/prophet-engine.ts`.
 */
export class ProphetEngine implements ForecastEngine {
  name = "seasonal_regression";
  minDays = 90; // Requires more data for seasonality

  async forecast(params: ForecastParams): Promise<ForecastResult> {
    const { series, horizonDays, confidenceLevel = 0.95 } = params;

    if (series.length < this.minDays) {
      throw new Error(`Seasonal regression requires at least ${this.minDays} days of data`);
    }

    const values = series.map((p) => p.value);
    const trend = fitLinearTrend(values);
    const residuals = values.map((value, i) => value - predictTrend(trend, i));
    const weeklySeasonality = fitWeeklySeasonality(residuals);
    const residualStdev = standardDeviation(residuals);
    const lastResidual = residuals[residuals.length - 1] ?? 0;

    const forecast: number[] = [];
    const confidenceLower: number[] = [];
    const confidenceUpper: number[] = [];
    const zScore = zScoreForConfidence(confidenceLevel);

    for (let i = 0; i < horizonDays; i++) {
      const x = values.length + i;
      const seasonal = weeklySeasonality[x % 7] ?? 0;
      const arResidual = lastResidual * Math.pow(0.65, i + 1);
      const predicted = Math.max(0, predictTrend(trend, x) + seasonal + arResidual);
      const margin = residualStdev * zScore * Math.sqrt(i + 1);

      forecast.push(predicted);
      confidenceLower.push(Math.max(0, predicted - margin));
      confidenceUpper.push(predicted + margin);
    }

    return {
      method: this.name,
      forecast,
      confidenceLower,
      confidenceUpper,
      confidenceLevel,
    };
  }
}

interface LinearTrend {
  intercept: number;
  slope: number;
}

function fitLinearTrend(values: number[]): LinearTrend {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    numerator += dx * (values[i]! - meanY);
    denominator += dx * dx;
  }

  const slope = denominator > 0 ? numerator / denominator : 0;
  return { intercept: meanY - slope * meanX, slope };
}

function predictTrend(trend: LinearTrend, x: number): number {
  return trend.intercept + trend.slope * x;
}

function fitWeeklySeasonality(residuals: number[]): number[] {
  const buckets = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }));
  residuals.forEach((residual, index) => {
    const bucket = buckets[index % 7]!;
    bucket.sum += residual;
    bucket.count += 1;
  });
  const raw = buckets.map((bucket) => bucket.count > 0 ? bucket.sum / bucket.count : 0);
  const mean = raw.reduce((sum, value) => sum + value, 0) / raw.length;
  return raw.map((value) => value - mean);
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function zScoreForConfidence(confidenceLevel: number): number {
  if (confidenceLevel >= 0.99) return 2.58;
  if (confidenceLevel >= 0.98) return 2.33;
  if (confidenceLevel >= 0.95) return 1.96;
  if (confidenceLevel >= 0.9) return 1.64;
  return 1.28;
}
