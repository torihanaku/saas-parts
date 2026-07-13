import type { ForecastEngine, ForecastParams, ForecastResult } from "./forecast-engine";
import { arLeastSquareDegree1, populationStdev } from "./ar-least-square";

/**
 * ARIMA(1,1,1) approximation based forecast (for 90+ days of data).
 * Uses AR(1) on differenced data to capture trends and momentum.
 *
 * Ported from 実運用SaaS `server/lib/forecast/arima-engine.ts`;
 * the `timeseries-analysis` dependency was replaced by the inlined
 * degree-1 equivalents in `./ar-least-square` (numerically identical).
 */
export const arimaEngine: ForecastEngine = {
  name: 'arima',
  minDays: 90,
  async forecast(params: ForecastParams): Promise<ForecastResult> {
    const { series, horizonDays, confidenceLevel = 0.95 } = params;

    if (series.length < 90) {
      console.warn(`arimaEngine: Data length ${series.length} is below recommended 90 days.`);
    }

    if (series.length < 7) {
      throw new Error("ARIMA requires at least 7 data points for minimal processing.");
    }

    // 1. Differencing (d=1) to handle non-stationarity
    const values = series.map(p => p.value);
    const originalLastValue = values[values.length - 1]!;

    const diffs: number[] = [];
    for (let i = 1; i < series.length; i++) {
      diffs.push(values[i]! - values[i - 1]!);
    }

    // 2. AR(1) on differenced data (p=1)
    // This captures the "momentum" of the changes
    const arCoeff = arLeastSquareDegree1(diffs) || 0;

    // 3. Forecast
    const forecast: number[] = [];
    const lower: number[] = [];
    const upper: number[] = [];

    const std = populationStdev(diffs);

    // Z-score for confidence level
    let z = 1.96;
    if (confidenceLevel >= 0.99) z = 2.576;
    else if (confidenceLevel <= 0.90) z = 1.645;

    let currentLastValue = originalLastValue;
    let currentLastDiff = diffs[diffs.length - 1]!;

    for (let i = 1; i <= horizonDays; i++) {
      // nextDiff = coeff * lastDiff
      const nextDiff = arCoeff * currentLastDiff;
      const predictedValue = Math.max(0, currentLastValue + nextDiff);

      // Uncertainty grows with sqrt(i)
      const margin = z * std * Math.sqrt(i);

      forecast.push(predictedValue);
      lower.push(Math.max(0, predictedValue - margin));
      upper.push(predictedValue + margin);

      currentLastValue = predictedValue;
      currentLastDiff = nextDiff;
    }

    return {
      forecast,
      confidenceLower: lower,
      confidenceUpper: upper,
      confidenceLevel,
      method: 'arima',
      reason: `ARIMA(1,1,1) approximation based on ${series.length} days of history (AR coeff: ${arCoeff.toFixed(3)}).`
    };
  },
};
