/**
 * COS React hooks（元: src/hooks/cos/*.ts, COS-7）。
 *
 * 汎用化: プロジェクト固有の `api-client` シングルトンを `CosApiClient`
 * インターフェースの引数注入に置き換えた。各 hook の第 1 引数に fetcher を
 * 渡す（useMemo 等で安定参照にすること）。
 * エンドポイントのパスは元実装の URL 契約（/cos/...）をそのまま踏襲。
 *
 * 落としたもの: useCosConsent（プロジェクトの consent ルート /consent と
 * ApiError 型に密結合。@torihanaku/consent 導入時に再構築する方が自然）。
 */
import { useCallback, useEffect, useState } from "react";
import type {
  CosBriefing,
  CosBriefingType,
  CosDigestItem,
  CosEmailSettings,
  CosSourceType,
  CosExtractedTask,
  EmailFilterRule,
  EmailIntegration,
} from "../types";
import type { QaOutput } from "../qa-engine";

/**
 * HTTP クライアントの注入点。JSON をパースして返し、非 2xx は
 * `{ status?: number }` を持つ Error を throw する契約（元 api-client と同じ）。
 */
export interface CosApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
}

// ─── feed ────────────────────────────────────────────────────────────────────

export interface CosFeedFilters {
  sourceType?: CosSourceType;
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
}

export function buildFeedQuery(filters: CosFeedFilters): string {
  const parts: string[] = [];
  if (filters.sourceType) parts.push(`sourceType=${filters.sourceType}`);
  if (filters.sinceIso) parts.push(`sinceIso=${encodeURIComponent(filters.sinceIso)}`);
  if (filters.untilIso) parts.push(`untilIso=${encodeURIComponent(filters.untilIso)}`);
  if (filters.limit) parts.push(`limit=${filters.limit}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export function useCosFeed(api: CosApiClient, filters: CosFeedFilters = {}) {
  const [items, setItems] = useState<CosDigestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const query = buildFeedQuery(filters);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ items: CosDigestItem[] }>(`/cos/feed${query}`);
      setItems(res.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [api, query]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { items, loading, error, refetch };
}

// ─── ask（Q&A） ──────────────────────────────────────────────────────────────

export function useCosAsk(api: CosApiClient) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QaOutput | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const ask = useCallback(
    async (question: string, topK?: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.post<QaOutput>("/cos/ask", { question, topK });
        setResult(res);
        return res;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { ask, reset, loading, result, error };
}

// ─── briefings ───────────────────────────────────────────────────────────────

export function useCosBriefings(api: CosApiClient, type?: CosBriefingType, limit = 10) {
  const [items, setItems] = useState<CosBriefing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (type) qs.set("type", type);
      qs.set("limit", String(limit));
      const res = await api.get<{ briefings: CosBriefing[] }>(
        `/cos/briefings?${qs.toString()}`,
      );
      setItems(res.briefings ?? []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [api, type, limit]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const generate = useCallback(
    async (briefingType: "daily" | "weekly") => {
      return await api.post<{ id: string; type: string; summary_text: string }>(
        "/cos/briefings",
        { type: briefingType },
      );
    },
    [api],
  );

  return { items, loading, error, refetch, generate };
}

// ─── tasks（レビューUI） ─────────────────────────────────────────────────────

export function useCosTasks(api: CosApiClient) {
  const [items, setItems] = useState<CosExtractedTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ items: CosExtractedTask[] }>("/cos/tasks/pending");
      setItems(res.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { items, loading, error, refetch };
}

export function useCosConfirmTask(api: CosApiClient) {
  const [loading, setLoading] = useState(false);
  const confirm = useCallback(
    async (taskId: string) => {
      setLoading(true);
      try {
        return await api.post<{ ok: boolean }>(
          `/cos/tasks/${encodeURIComponent(taskId)}/confirm`,
        );
      } finally {
        setLoading(false);
      }
    },
    [api],
  );
  return { confirm, loading };
}

export function useCosRejectTask(api: CosApiClient) {
  const [loading, setLoading] = useState(false);
  const reject = useCallback(
    async (taskId: string) => {
      setLoading(true);
      try {
        return await api.post<{ ok: boolean }>(
          `/cos/tasks/${encodeURIComponent(taskId)}/reject`,
        );
      } finally {
        setLoading(false);
      }
    },
    [api],
  );
  return { reject, loading };
}

export function useCosSyncTask(api: CosApiClient) {
  const [loading, setLoading] = useState(false);
  const sync = useCallback(
    async (taskId: string, target: string) => {
      setLoading(true);
      try {
        return await api.post<{
          ok: boolean;
          externalId?: string;
          externalUrl?: string;
          syncedTo?: string;
        }>(`/cos/tasks/${encodeURIComponent(taskId)}/sync?target=${target}`);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );
  return { sync, loading };
}

// ─── ingest 手動トリガー ─────────────────────────────────────────────────────

export interface IngestResult {
  ok: boolean;
  ingested?: number;
  skipped?: number;
}

export function useCosIngest(api: CosApiClient, source: "slack") {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ingest = useCallback(async () => {
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const data = await api.post<IngestResult>(`/cos/${source}/ingest`);
      setResult(data);
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      if (status === 403) {
        setError("permission_denied");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [api, source]);

  return { ingest, loading, result, error };
}

// ─── settings ────────────────────────────────────────────────────────────────

export interface CosSettingsView {
  tenantId: string;
  ownerUserId: string;
  slackChannels: string[];
  emailFilterRules: unknown[];
  meetingSources: string[];
  dailyBriefingEnabled: boolean;
  dailyBriefingTime: string;
  lastSlackIngestedAt: string | null;
  lastEmailIngestedAt: string | null;
  lastMeetingIngestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CosSettingsPatch {
  slackChannels?: string[];
  emailFilterRules?: unknown[];
  meetingSources?: string[];
  dailyBriefingEnabled?: boolean;
  dailyBriefingTime?: string;
}

export function useCosSettings(api: CosApiClient) {
  const [data, setData] = useState<CosSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ settings: CosSettingsView | null }>("/cos/settings");
      setData(res.settings);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const update = useCallback(
    async (patch: CosSettingsPatch) => {
      const res = await api.patch<{ settings: CosSettingsView | null }>(
        "/cos/settings",
        patch,
      );
      setData(res.settings);
      return res.settings;
    },
    [api],
  );

  return { data, loading, error, refetch, update };
}

// ─── email settings ──────────────────────────────────────────────────────────

export interface CosEmailSettingsPatch {
  integration?: EmailIntegration;
  connectionId?: string | null;
  enabled?: boolean;
  filterRules?: EmailFilterRule[];
  lookbackHours?: number;
}

export function useCosEmailSettings(api: CosApiClient) {
  const [data, setData] = useState<CosEmailSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ settings: CosEmailSettings }>(
        "/cos/settings/email-filters",
      );
      setData(res.settings);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 501) {
        setLoading(false);
        return;
      }
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const update = useCallback(
    async (patch: CosEmailSettingsPatch) => {
      const res = await api.patch<{ settings: CosEmailSettings }>(
        "/cos/settings/email-filters",
        patch,
      );
      setData(res.settings);
      return res.settings;
    },
    [api],
  );

  return { data, loading, error, refetch, update };
}
