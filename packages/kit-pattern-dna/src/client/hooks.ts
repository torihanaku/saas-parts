/**
 * client/hooks.ts — React フック（フェッチャ注入版）。
 *
 * 出典: 実運用SaaS `src/hooks/usePatternAlerts.ts`,
 * `useCompanyDnaStats.ts`, `useBrandDna.ts`。
 * アプリ全体の `api` クライアント → 注入インターフェース PatternDnaClientApi、
 * エンドポイント → オプション（デフォルトは本家の値を維持）に置き換えた。
 * 本家 useCompanyDnaStats の brand-dna 統計への 404/501 フォールバックは
 * ルート構成固有のためキットでは落とした（README 参照）。
 */

import { useState, useCallback, useEffect, useRef } from "react";
import type { DnaStats, PatternDnaType } from "../types.js";
import type {
  PatternAlertsResult,
} from "../pattern-alerts.js";
import type { SnapshotStats, SnapshotSummary } from "../similarity-predict.js";
import type { ApprovalStatus } from "../stores.js";

// ─── 注入インターフェース ───────────────────────────────────────────────────

/** アプリの HTTP クライアントを注入する最小インターフェース。 */
export interface PatternDnaClientApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface PatternDnaEndpoints {
  /** DNA 統計。デフォルト "/api/dna/stats"。 */
  stats: string;
  /** パターンアラート照合。デフォルト "/api/dna/alerts/check"。 */
  alertsCheck: string;
  /** 類似予測。デフォルト "/api/brand-dna/predict"。 */
  predict: string;
  /** 類似推薦。デフォルト "/api/brand-dna/recommend"。 */
  recommend: string;
  /** スナップショット一覧。デフォルト "/api/brand-dna/snapshots"。 */
  snapshots: string;
  /** スナップショット統計。デフォルト "/api/brand-dna/stats"。 */
  snapshotStats: string;
}

export const DEFAULT_PATTERN_DNA_ENDPOINTS: PatternDnaEndpoints = {
  stats: "/api/dna/stats",
  alertsCheck: "/api/dna/alerts/check",
  predict: "/api/brand-dna/predict",
  recommend: "/api/brand-dna/recommend",
  snapshots: "/api/brand-dna/snapshots",
  snapshotStats: "/api/brand-dna/stats",
};

export interface CheckPatternAlertsClientArgs {
  draftText: string;
  dnaType?: PatternDnaType;
  threshold?: number;
  maxHits?: number;
}

const EMPTY_RESULT: PatternAlertsResult = {
  failureWarnings: [],
  successRecommendations: [],
  scanned: 0,
  threshold: 0,
};

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// ─── フック生成ファクトリ ───────────────────────────────────────────────────

export interface UsePatternAlertsReturn {
  data: PatternAlertsResult | null;
  loading: boolean;
  error: Error | null;
  check: (args: CheckPatternAlertsClientArgs) => Promise<PatternAlertsResult | null>;
  reset: () => void;
}

export interface UseAutoPatternAlertsArgs extends CheckPatternAlertsClientArgs {
  /** 自動フェッチの無効化（デフォルト false = 有効）。 */
  enabled?: boolean;
  /** draftText 変更のデバウンス幅。デフォルト 600ms。 */
  debounceMs?: number;
  /** draftText がこの文字数未満のときスキップ。デフォルト 30。 */
  minLength?: number;
}

export interface UseAutoPatternAlertsReturn {
  data: PatternAlertsResult;
  loading: boolean;
  error: Error | null;
  /** デバウンスを飛ばして今すぐ再照合する。 */
  refresh: () => void;
}

/**
 * フェッチャ + エンドポイントを束縛したフック群を生成する。
 *
 * ```tsx
 * const dna = createPatternDnaHooks(api);
 * const { data } = dna.useDnaStats();
 * const { data: alerts } = dna.useAutoPatternAlerts({ draftText });
 * ```
 */
export function createPatternDnaHooks(
  api: PatternDnaClientApi,
  endpoints: Partial<PatternDnaEndpoints> = {},
) {
  const ep: PatternDnaEndpoints = { ...DEFAULT_PATTERN_DNA_ENDPOINTS, ...endpoints };

  /** DNA 統計（総数・タイプ別内訳・平均 confidence）。 */
  function useDnaStats() {
    const [data, setData] = useState<DnaStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const fetchStats = useCallback(async () => {
      setLoading(true);
      try {
        const result = await api.get<DnaStats>(ep.stats);
        setData(result);
        setError(null);
      } catch (err) {
        setError(toError(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      fetchStats();
    }, [fetchStats]);

    return { data, loading, error, refetch: fetchStats };
  }

  /** スナップショット統計（承認 / 却下 / 保留の内訳 + 実績行数）。 */
  function useSnapshotStats() {
    const [data, setData] = useState<SnapshotStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const fetchStats = useCallback(async () => {
      setLoading(true);
      try {
        const result = await api.get<SnapshotStats>(ep.snapshotStats);
        setData(result);
        setError(null);
      } catch (err) {
        setError(toError(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      fetchStats();
    }, [fetchStats]);

    return { data, loading, error, refetch: fetchStats };
  }

  /** スナップショット一覧（承認状態フィルタ + ページング）。 */
  function useSnapshots(
    filters: { approvalStatus?: ApprovalStatus; limit?: number; offset?: number } = {},
  ) {
    const [data, setData] = useState<SnapshotSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const fetchSnapshots = useCallback(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (filters.approvalStatus) params.append("approvalStatus", filters.approvalStatus);
        if (filters.limit) params.append("limit", String(filters.limit));
        if (filters.offset) params.append("offset", String(filters.offset));

        const query = params.toString() ? `?${params.toString()}` : "";
        const result = await api.get<SnapshotSummary[]>(`${ep.snapshots}${query}`);
        setData(result || []);
        setError(null);
      } catch (err) {
        setError(toError(err));
      } finally {
        setLoading(false);
      }
    }, [filters.approvalStatus, filters.limit, filters.offset]);

    useEffect(() => {
      fetchSnapshots();
    }, [fetchSnapshots]);

    return { data, loading, error, refetch: fetchSnapshots };
  }

  /** 類似予測の命令的フック。 */
  function usePredict() {
    const [loading, setLoading] = useState(false);

    const predict = async (contentText: string, channel: string) => {
      setLoading(true);
      try {
        return await api.post<unknown>(ep.predict, { contentText, channel });
      } finally {
        setLoading(false);
      }
    };

    return { predict, loading };
  }

  /** 類似推薦の命令的フック。 */
  function useRecommend() {
    const [loading, setLoading] = useState(false);

    const recommend = async (contentText: string, candidateChannels?: string[]) => {
      setLoading(true);
      try {
        return await api.post<unknown>(ep.recommend, { contentText, candidateChannels });
      } finally {
        setLoading(false);
      }
    };

    return { recommend, loading };
  }

  /**
   * パターンアラートの命令的フック — 呼び出し側が `check()` を叩いたとき
   * のみリクエストする。stale レスポンスは新しいリクエストが勝つ。
   */
  function usePatternAlerts(): UsePatternAlertsReturn {
    const [data, setData] = useState<PatternAlertsResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    // 進行中の最新リクエストを追跡し、順序が前後したレスポンスが新しい結果を
    // 上書きしないようにする。check() のたびにインクリメント。
    const reqIdRef = useRef(0);

    const check = useCallback(
      async (args: CheckPatternAlertsClientArgs): Promise<PatternAlertsResult | null> => {
        const id = ++reqIdRef.current;
        setLoading(true);
        setError(null);
        try {
          const result = await api.post<PatternAlertsResult>(ep.alertsCheck, args);
          if (id !== reqIdRef.current) return null; // stale — 新しいリクエストが勝つ
          setData(result);
          return result;
        } catch (err) {
          if (id !== reqIdRef.current) return null;
          setError(toError(err));
          return null;
        } finally {
          if (id === reqIdRef.current) setLoading(false);
        }
      },
      [],
    );

    const reset = useCallback(() => {
      reqIdRef.current += 1; // 進行中のレスポンスを無効化
      setData(null);
      setError(null);
      setLoading(false);
    }, []);

    return { data, loading, error, check, reset };
  }

  /**
   * 宣言的なデバウンス付きフック — draftText の変化で自動的に再照合する。
   * `enabled` でゲートできる（パネルが閉じている間は暗いままにする等）。
   * エラーは throw せず `error` フィールドで返す。
   */
  function useAutoPatternAlerts(args: UseAutoPatternAlertsArgs): UseAutoPatternAlertsReturn {
    const {
      draftText,
      dnaType,
      threshold,
      maxHits,
      enabled = true,
      debounceMs = 600,
      minLength = 30,
    } = args;

    const [data, setData] = useState<PatternAlertsResult>(EMPTY_RESULT);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const reqIdRef = useRef(0);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const run = useCallback(async () => {
      if (!enabled) return;
      if (typeof draftText !== "string" || draftText.trim().length < minLength) {
        setData(EMPTY_RESULT);
        setError(null);
        return;
      }

      const id = ++reqIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const result = await api.post<PatternAlertsResult>(ep.alertsCheck, {
          draftText,
          dnaType,
          threshold,
          maxHits,
        });
        if (id !== reqIdRef.current) return;
        setData(result);
      } catch (err) {
        if (id !== reqIdRef.current) return;
        setError(toError(err));
        setData(EMPTY_RESULT);
      } finally {
        if (id === reqIdRef.current) setLoading(false);
      }
    }, [enabled, draftText, dnaType, threshold, maxHits, minLength]);

    // デバウンス付き effect
    useEffect(() => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (!enabled) {
        setData(EMPTY_RESULT);
        return;
      }
      timerRef.current = setTimeout(() => {
        run();
      }, debounceMs);
      return () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
      };
    }, [enabled, debounceMs, run]);

    const refresh = useCallback(() => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      void run();
    }, [run]);

    return { data, loading, error, refresh };
  }

  return {
    useDnaStats,
    useSnapshotStats,
    useSnapshots,
    usePredict,
    useRecommend,
    usePatternAlerts,
    useAutoPatternAlerts,
  };
}
