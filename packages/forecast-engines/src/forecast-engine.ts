/**
 * Common forecasting interface + result shape.
 * Ported from 実運用SaaS `server/lib/forecast/forecast-engine.ts`;
 * `ForecastResult` was inlined from `shared/types/marketing.ts`
 * (with `method` widened to `string` — the seasonal-regression engine
 * reports "seasonal_regression", which the original union didn't cover).
 */

export interface ForecastResult {
  forecast: number[];
  confidenceLower: number[];
  confidenceUpper: number[];
  /** 0.95 etc. */
  confidenceLevel: number;
  /** Which forecasting method produced this result ("arima" | "moving_average" | "seasonal_regression"). */
  method: string;
  /** Human-readable reason (e.g. why this engine was auto-selected). */
  reason?: string;
}

/** ForecastEngine interface — engines are auto-selected by available data length. */
export interface ForecastEngine {
  readonly name: string;
  /** Minimum number of daily data points this engine needs. */
  readonly minDays: number;
  forecast(params: ForecastParams): Promise<ForecastResult>;
}

export interface ForecastParams {
  /** Daily time series (oldest → newest). */
  series: { date: string; value: number }[];
  /** How many days ahead to forecast. */
  horizonDays: number;
  /** Confidence level (default: 0.95). */
  confidenceLevel?: number;
}

/** Auto-selection logic by data volume; returns null below the minimum so callers can surface an explicit error. */
export interface ForecastEngineSelector {
  pickEngine(availableDays: number): ForecastEngine | null;
}
