/**
 * Hooks for the Scenario Twin dashboard (ported from dev-dashboard-v2 useTwin).
 *
 * The HTTP client is injected (`TwinApiClient`). `react` is a peer dependency.
 */

import { useState, useCallback, useEffect } from "react";
import type { TwinSimulation, TwinBaseline } from "../types.js";
import type { CompareOutput } from "../comparison-service.js";
import type { SensitivityOutput } from "../sensitivity-service.js";
import type { BacktestRecord } from "../store.js";
import type { BacktestAccuracy } from "../backtest-service.js";

export interface CompareScenarioInput {
  name: string;
  inputs: Record<string, number>;
}

/** Minimal injected HTTP surface. */
export interface TwinApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function useTwinSimulate(api: TwinApiClient) {
  const [loading, setLoading] = useState(false);

  const run = async (input: {
    scenarioName: string;
    scenarioInputs: Record<string, number>;
    periodHorizonDays?: number;
    confidenceLevel?: number;
  }): Promise<TwinSimulation> => {
    setLoading(true);
    try {
      const res = await api.post<{ success: boolean; simulation: TwinSimulation }>(
        "/twin/simulate",
        input,
      );
      return res.simulation;
    } finally {
      setLoading(false);
    }
  };

  return { run, loading };
}

export function useTwinCompare(api: TwinApiClient) {
  const [loading, setLoading] = useState(false);

  const run = async (input: {
    scenarios: CompareScenarioInput[];
    periodHorizonDays?: number;
    confidenceLevel?: number;
  }): Promise<CompareOutput> => {
    setLoading(true);
    try {
      const res = await api.post<{ success: boolean; comparison: CompareOutput }>(
        "/twin/compare",
        input,
      );
      return res.comparison;
    } finally {
      setLoading(false);
    }
  };

  return { run, loading };
}

export function useTwinSensitivity(api: TwinApiClient) {
  const [loading, setLoading] = useState(false);

  const run = async (input: {
    baseScenario: Record<string, number>;
    perturbationPercent?: number;
  }): Promise<SensitivityOutput> => {
    setLoading(true);
    try {
      const res = await api.post<{
        success: boolean;
        sensitivity: SensitivityOutput;
      }>("/twin/sensitivity", input);
      return res.sensitivity;
    } finally {
      setLoading(false);
    }
  };

  return { run, loading };
}

export function useTwinBacktest(api: TwinApiClient) {
  const [records, setRecords] = useState<BacktestRecord[]>([]);
  const [accuracy, setAccuracy] = useState<BacktestAccuracy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [recRes, accRes] = await Promise.all([
        api.get<{ success: boolean; records: BacktestRecord[] }>(
          "/twin/backtest?limit=50",
        ),
        api.get<{ success: boolean; accuracy: BacktestAccuracy[] }>(
          "/twin/backtest/accuracy?limit=50",
        ),
      ]);
      setRecords(recRes.records || []);
      setAccuracy(accRes.accuracy || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return { records, accuracy, loading, error, refetch: fetchAll };
}

export function useTwinBaseline(api: TwinApiClient) {
  const [data, setData] = useState<TwinBaseline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchLatest = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{
        success: boolean;
        baseline: TwinBaseline | null;
      }>("/twin/baseline");
      setData(res.baseline ?? null);
      setError(null);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const status = (err as { status?: number } | null)?.status;
      if (status === 404) {
        setData(null);
        setError(null);
      } else {
        setError(e);
      }
    } finally {
      setLoading(false);
    }
  }, [api]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.post<{
        success: boolean;
        baseline: TwinBaseline | null;
      }>("/twin/baseline/refresh", {});
      setData(res.baseline ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchLatest();
  }, [fetchLatest]);

  return { data, loading, error, refetch: fetchLatest, refresh };
}
