/**
 * useBiasDetections — fetch bias detections for a decision (ported, #1300/#356).
 *
 * Read-only hook. The HTTP client is injected (`BiasApiClient`) so this stays
 * decoupled from any specific api-client / auth implementation. Returns [] when
 * the feature flag is OFF (server returns an empty body / 404).
 */

import { useEffect, useState } from "react";
import type { BiasDetection } from "../types.js";

/** Minimal injected HTTP surface: a typed GET. */
export interface BiasApiClient {
  get<T>(path: string): Promise<T>;
}

interface HistoryResponse {
  detections: Array<{
    id: string;
    tenantId: string | null;
    decisionId: string | null;
    biasType: string;
    confidence: number;
    evidence: Record<string, unknown>;
    recommendation: string | null;
    detectedAt: string;
    detectorVersion?: string | null;
    decisionMakerRole?: string | null;
  }>;
}

/**
 * Tenant-wide hook used by the list view to know which decisions have any bias
 * detection. Returns a map of decisionId -> count.
 */
export function useBiasDetectionsByDecision(api: BiasApiClient, enabled = true) {
  const [data, setData] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api
      .get<HistoryResponse>("/bias-detection/history")
      .then((res) => {
        if (cancelled) return;
        const map = new Map<string, number>();
        for (const d of res?.detections ?? []) {
          if (!d.decisionId) continue;
          map.set(d.decisionId, (map.get(d.decisionId) ?? 0) + 1);
        }
        setData(map);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(new Map());
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, enabled]);

  return {
    data: enabled ? data : new Map<string, number>(),
    loading: enabled ? loading : false,
    error: enabled ? error : null,
  };
}

export function useBiasDetections(
  api: BiasApiClient,
  decisionId: string | null | undefined,
  enabled = true,
) {
  const [data, setData] = useState<BiasDetection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!decisionId || !enabled) return;
    let cancelled = false;
    api
      .get<HistoryResponse>(
        `/bias-detection/history?decision_id=${encodeURIComponent(decisionId)}`,
      )
      .then((res) => {
        if (cancelled) return;
        const list = (res?.detections ?? []).map(
          (d): BiasDetection => ({
            id: d.id,
            tenantId: d.tenantId ?? "",
            decisionId: d.decisionId,
            biasType: d.biasType as BiasDetection["biasType"],
            confidence: d.confidence,
            evidence: d.evidence ?? {},
            recommendation: d.recommendation ?? null,
            detectedAt: d.detectedAt,
            detectorVersion: d.detectorVersion ?? undefined,
            decisionMakerRole:
              (d.decisionMakerRole as BiasDetection["decisionMakerRole"]) ?? null,
          }),
        );
        setData(list);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Flag OFF / unauthorized — surface as empty rather than error.
        setData([]);
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, decisionId, enabled]);

  return {
    data: enabled && decisionId ? data : [],
    loading: enabled && decisionId ? loading : false,
    error: enabled && decisionId ? error : null,
  };
}
