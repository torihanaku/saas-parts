/**
 * React hooks for a Budget Allocation UI (ported from 実運用SaaS
 * src/hooks/useBudgetReallocations.ts).
 *
 * The original imported a concrete `api` client and page-local DTO types. Here
 * the HTTP client is injected via `ApiClient` so the hook has no app coupling.
 */

import { useCallback, useEffect, useState } from "react";
import type {
  AdPlatform,
  BudgetReallocationMode,
  BudgetReallocationStatus,
  BudgetReallocationTrigger,
  BudgetSafetyCheckResult,
} from "../types";

export interface BudgetReallocationDto {
  id: string;
  tenantId: string;
  status: BudgetReallocationStatus;
  mode: BudgetReallocationMode;
  triggerType: string;
  triggerDetail: BudgetReallocationTrigger;
  sourcePlatform: AdPlatform;
  sourceCampaignId: string;
  targetPlatform: AdPlatform;
  targetCampaignId: string;
  currentDailyBudgetJpy: number;
  proposedDailyBudgetJpy: number;
  deltaJpy: number;
  expectedLiftRoas: number | null;
  rationale: string;
  safetyCheck: BudgetSafetyCheckResult;
  proposedAt: string;
  proposedBy: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  executedAt: string | null;
  executedBy: string | null;
  rollbackAt: string | null;
  rollbackReason: string | null;
  auditLogId: string | null;
  externalRef: string | null;
}

/** Minimal injected HTTP client (matches the app's `api` shape). */
export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown, init?: { headers?: Record<string, string> }): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
}

interface HistoryResponse {
  reallocations?: BudgetReallocationDto[];
}

export function useBudgetReallocations(api: ApiClient, statusFilter?: string) {
  const [data, setData] = useState<BudgetReallocationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : "";
      const res = await api.get<HistoryResponse | BudgetReallocationDto[]>(
        `/budget-reallocation/history${qs}`,
      );
      const list = Array.isArray(res) ? res : (res?.reallocations ?? []);
      setData(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [api, statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export function useExecuteReallocation(api: ApiClient) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const execute = useCallback(
    async (reallocationId: string, reauthToken: string) => {
      setLoading(true);
      try {
        await api.post(
          `/budget-reallocation/execute`,
          { reallocationId, riskAcknowledged: true },
          { headers: { "X-Reauth-Token": reauthToken } },
        );
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        return false;
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  return { execute, loading, error };
}

export function useRejectReallocation(api: ApiClient) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const reject = useCallback(
    async (reallocationId: string, reason: string) => {
      setLoading(true);
      try {
        await api.patch(`/budget-reallocation/${reallocationId}`, {
          status: "rejected",
          rollbackReason: reason,
        });
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        return false;
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  return { reject, loading, error };
}
