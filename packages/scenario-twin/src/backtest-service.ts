/**
 * Backtest service (ported from dev-dashboard-v2 twin/backtest-service).
 *
 * Records predicted-vs-actual pairs and computes accuracy (MAPE / RMSE / MAE)
 * per metric. Persistence is injected via `TwinStore`.
 */

import type { BacktestRecord, TwinStore } from "./store.js";

export type { BacktestRecord } from "./store.js";

export interface BacktestAccuracy {
  metric: string;
  mape: number; // Mean Absolute Percentage Error
  rmse: number; // Root Mean Square Error
  mae: number; // Mean Absolute Error (raw scale)
  count: number;
}

export async function recordBacktest(
  params: {
    tenantId: string;
    simulationId: string;
    metric: string;
    predicted: number;
    actual: number;
  },
  store: TwinStore,
): Promise<string> {
  const errorPercent =
    params.predicted !== 0
      ? ((params.actual - params.predicted) / params.predicted) * 100
      : null;

  return store.insertBacktest({
    tenantId: params.tenantId,
    simulationId: params.simulationId,
    metric: params.metric,
    predicted: params.predicted,
    actual: params.actual,
    errorPercent,
    recordedAt: new Date().toISOString(),
  });
}

export async function listBacktest(
  tenantId: string,
  store: TwinStore,
  limit = 50,
): Promise<BacktestRecord[]> {
  return store.listBacktest(tenantId, limit);
}

export async function calculateAccuracy(
  tenantId: string,
  store: TwinStore,
  limit = 50,
): Promise<BacktestAccuracy[]> {
  const records = await listBacktest(tenantId, store, limit);
  if (records.length === 0) return [];

  const metricsObj: Record<
    string,
    { apeSum: number; sqErrSum: number; absErrSum: number; count: number }
  > = {};

  for (const r of records) {
    if (r.predicted == null || r.actual == null) continue;
    const bucket = (metricsObj[r.metric] ??= {
      apeSum: 0,
      sqErrSum: 0,
      absErrSum: 0,
      count: 0,
    });

    const ape =
      r.predicted !== 0 ? Math.abs((r.actual - r.predicted) / r.predicted) : 0;
    bucket.apeSum += ape;
    bucket.sqErrSum += Math.pow(r.actual - r.predicted, 2);
    bucket.absErrSum += Math.abs(r.actual - r.predicted);
    bucket.count++;
  }

  return Object.keys(metricsObj).map((m) => {
    const stat = metricsObj[m]!;
    return {
      metric: m,
      mape: stat.count > 0 ? (stat.apeSum / stat.count) * 100 : 0,
      rmse: stat.count > 0 ? Math.sqrt(stat.sqErrSum / stat.count) : 0,
      mae: stat.count > 0 ? stat.absErrSum / stat.count : 0,
      count: stat.count,
    };
  });
}
