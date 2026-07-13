/**
 * Hooks for the AB Testing dashboard (ported from 実運用SaaS #1359).
 *
 * The HTTP client is injected (`AbApiClient`) so these hooks stay decoupled
 * from any specific api-client. `react` is a peer dependency.
 */

import { useCallback, useEffect, useState } from "react";
import type { Experiment, Variant, WinnerDecision } from "../types.js";

/** Winner DTO returned by the API — structurally a `WinnerDecision`. */
export type WinnerDecisionDto = WinnerDecision;

/** Minimal injected HTTP surface: a typed GET. */
export interface AbApiClient {
  get<T>(path: string): Promise<T>;
}

interface ListResponse<T> {
  experiments?: T[];
}

export function useExperiments(api: AbApiClient) {
  const [data, setData] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<ListResponse<Experiment> | Experiment[]>(
        "/ab-testing/experiments",
      );
      const list = Array.isArray(res) ? res : (res?.experiments ?? []);
      setData(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

interface VariantsResponse {
  variants?: Variant[];
}

interface WinnerResponse {
  winner?: WinnerDecisionDto;
  decision?: WinnerDecisionDto;
}

export function useExperimentDetail(
  api: AbApiClient,
  experimentId: string | null,
) {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [winner, setWinner] = useState<WinnerDecisionDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!experimentId) return;
    setLoading(true);
    try {
      const [vRes, wRes] = await Promise.all([
        api
          .get<VariantsResponse | Variant[]>(
            `/ab-testing/experiments/${experimentId}/variants`,
          )
          .catch(() => ({ variants: [] }) as VariantsResponse),
        api
          .get<WinnerResponse | WinnerDecisionDto>(
            `/ab-testing/experiments/${experimentId}/winner`,
          )
          .catch(() => null),
      ]);
      const vList = Array.isArray(vRes) ? vRes : (vRes?.variants ?? []);
      setVariants(vList);
      const w =
        wRes && "winner" in wRes
          ? wRes.winner
          : wRes && "decision" in wRes
            ? wRes.decision
            : (wRes as WinnerDecisionDto | null);
      setWinner(w ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [api, experimentId]);

  useEffect(() => {
    if (experimentId) refetch();
  }, [experimentId, refetch]);

  return { variants, winner, loading, error, refetch };
}
