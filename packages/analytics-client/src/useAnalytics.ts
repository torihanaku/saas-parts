/**
 * Lightweight client-side analytics: page-view / feature-use / session
 * tracking with sendBeacon flushing on page unload.
 *
 * Ported from 実運用SaaS `src/hooks/useAnalytics.ts` (113 LOC).
 * Differences from the original:
 *   - app-wide `api` client → injectable {@link AnalyticsTransport}
 *   - endpoint / anonymous-id storage key → options (defaults preserve
 *     the original `/api/analytics` and `dd_anonymous_id`)
 */
import { useEffect, useCallback, useRef } from "react";

export interface AnalyticsEvent {
  event_type: string;
  page?: string;
  metadata?: Record<string, string | number | boolean>;
}

/** Payload actually sent over the wire (event + envelope). */
export interface AnalyticsPayload extends AnalyticsEvent {
  timestamp: string;
  user_id: string;
}

export interface AnalyticsTransport {
  /** Async JSON POST used for normal events. */
  post(path: string, body: AnalyticsPayload): Promise<unknown>;
  /** Fire-and-forget beacon used during page unload. */
  sendBeacon(path: string, body: AnalyticsPayload): void;
}

export interface AnalyticsConfig {
  /** Events endpoint. Default: "/api/analytics". */
  endpoint?: string;
  /** localStorage key for the anonymous user id. Default: "dd_anonymous_id". */
  storageKey?: string;
  /** Transport. Default: fetch + navigator.sendBeacon. */
  transport?: AnalyticsTransport;
}

export function createDefaultAnalyticsTransport(
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args)
): AnalyticsTransport {
  return {
    async post(path, body) {
      const res = await fetcher(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return undefined;
    },
    sendBeacon(path, body) {
      const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
      navigator.sendBeacon(path, blob);
    },
  };
}

/** Generate or retrieve a simple anonymous user ID stored in localStorage */
export function getAnonymousUserId(storageKey = "dd_anonymous_id"): string {
  let id = localStorage.getItem(storageKey);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(storageKey, id);
  }
  return id;
}

interface ResolvedConfig {
  endpoint: string;
  storageKey: string;
  transport: AnalyticsTransport;
}

function resolveConfig(config: AnalyticsConfig): ResolvedConfig {
  return {
    endpoint: config.endpoint ?? "/api/analytics",
    storageKey: config.storageKey ?? "dd_anonymous_id",
    transport: config.transport ?? createDefaultAnalyticsTransport(),
  };
}

function sendAnalyticsEvent(config: ResolvedConfig, event: AnalyticsEvent): void {
  try {
    config.transport.post(config.endpoint, {
      ...event,
      timestamp: new Date().toISOString(),
      user_id: getAnonymousUserId(config.storageKey),
    }).catch(() => {
      // Silent fail - analytics should never break the app
    });
  } catch {
    // Silent fail
  }
}

/**
 * Lightweight analytics hook for tracking page views and feature interactions.
 * Sends events to the configured endpoint (default `/api/analytics`).
 */
export function useAnalytics(currentPage: string, config: AnalyticsConfig = {}) {
  // Captured on first render so effects keep stable identities
  // (the original imported a module-level `api`).
  const configRef = useRef<ResolvedConfig | null>(null);
  if (configRef.current === null) configRef.current = resolveConfig(config);
  const resolved = configRef.current;

  const sessionStart = useRef(0);
  const lastPage = useRef("");

  // Initialize session start time on mount
  useEffect(() => {
    sessionStart.current = Date.now();
  }, []);

  // Track page view on page change
  useEffect(() => {
    if (currentPage !== lastPage.current) {
      sendAnalyticsEvent(resolved, {
        event_type: "page_view",
        page: currentPage,
      });
      lastPage.current = currentPage;
    }
  }, [currentPage, resolved]);

  // Track session duration on unmount / page leave
  useEffect(() => {
    const handleBeforeUnload = () => {
      const duration = Math.round((Date.now() - sessionStart.current) / 1000);
      resolved.transport.sendBeacon(resolved.endpoint, {
        event_type: "session_end",
        metadata: { duration_seconds: duration },
        timestamp: new Date().toISOString(),
        user_id: getAnonymousUserId(resolved.storageKey),
      });
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [resolved]);

  const trackFeatureUse = useCallback(
    (feature: string, metadata?: Record<string, string | number | boolean>) => {
      sendAnalyticsEvent(resolved, {
        event_type: "feature_use",
        page: currentPage,
        metadata: { feature, ...metadata },
      });
    },
    [currentPage, resolved]
  );

  return { trackFeatureUse };
}

// ─── Report types (server aggregation contract) ─────────────────

export interface DailyActiveUsers {
  date: string;
  count: number;
}

export interface FeatureUsage {
  name: string;
  count: number;
}

export interface PageView {
  page: string;
  count: number;
}

export interface SessionDurationTrend {
  date: string;
  avg_duration: number;
}

export interface AnalyticsReport {
  daily_active_users: DailyActiveUsers[];
  feature_usage: FeatureUsage[];
  page_views: PageView[];
  session_duration_trends: SessionDurationTrend[];
  total_events: number;
}
