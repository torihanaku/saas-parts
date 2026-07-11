/**
 * React hook for in-app notifications: history fetch + SSE subscribe +
 * localStorage preferences + unreadCount / markAsRead / markAllAsRead.
 *
 * Ported from dev-dashboard-v2 `src/hooks/useNotifications.ts` (106 LOC).
 * Differences from the original:
 *   - app-wide `api` client → injectable {@link NotificationsClientApi}
 *   - endpoints / storage key / default preferences / list cap /
 *     reconnect delay → options (defaults preserve the original values)
 */
import { useState, useEffect, useCallback, useRef } from "react";
import {
  createDefaultNotificationsApi,
  toArray,
  type NotificationsClientApi,
  type NotificationStreamHandle,
} from "./api";

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  user_id: string;
  created_at: string;
}

export interface NotificationPreferences {
  enabled: boolean;
  types: Record<string, boolean>;
}

export interface NotificationEndpoints {
  /** History list endpoint. Default: "/api/notifications". */
  list: string;
  /** SSE stream endpoint. Default: "/api/notifications/stream". */
  stream: string;
  /** Mark-as-read endpoint builder. Default: id => `/api/notifications/${id}/read`. */
  markRead: (id: string) => string;
}

export interface UseNotificationsOptions {
  /** Client API. Default: fetch/EventSource-based implementation. */
  api?: NotificationsClientApi;
  /** Endpoint overrides. */
  endpoints?: Partial<NotificationEndpoints>;
  /** localStorage key for preferences. Default: "techradar-notification-prefs" (original value). */
  storageKey?: string;
  /** Preferences used when nothing is stored. Default: original type map, all enabled. */
  defaultPreferences?: NotificationPreferences;
  /** Max notifications kept in memory. Default: 100. */
  maxItems?: number;
  /** SSE reconnect delay in ms. Default: 5000. */
  reconnectDelayMs?: number;
}

const PREFS_STORAGE_KEY = "techradar-notification-prefs";

const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: true,
  types: {
    "ci-failure": true, "ci-success": true, "backlog-added": true,
    "cost-alert": true, "team-status": true, "claude-session": true,
  },
};

export function loadPreferences(
  storageKey: string = PREFS_STORAGE_KEY,
  defaults: NotificationPreferences = DEFAULT_PREFERENCES
): NotificationPreferences {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return { enabled: defaults.enabled, types: { ...defaults.types } };
}

interface ResolvedConfig {
  api: NotificationsClientApi;
  endpoints: NotificationEndpoints;
  storageKey: string;
  defaultPreferences: NotificationPreferences;
  maxItems: number;
  reconnectDelayMs: number;
}

function resolveConfig(options: UseNotificationsOptions): ResolvedConfig {
  return {
    api: options.api ?? createDefaultNotificationsApi(),
    endpoints: {
      list: options.endpoints?.list ?? "/api/notifications",
      stream: options.endpoints?.stream ?? "/api/notifications/stream",
      markRead: options.endpoints?.markRead ?? ((id: string) => `/api/notifications/${id}/read`),
    },
    storageKey: options.storageKey ?? PREFS_STORAGE_KEY,
    defaultPreferences: options.defaultPreferences ?? DEFAULT_PREFERENCES,
    maxItems: options.maxItems ?? 100,
    reconnectDelayMs: options.reconnectDelayMs ?? 5000,
  };
}

export function useNotifications(options: UseNotificationsOptions = {}) {
  // Config is captured on first render so the effect dependencies stay stable
  // (the original imported a module-level `api`, giving the same stability).
  const configRef = useRef<ResolvedConfig | null>(null);
  if (configRef.current === null) configRef.current = resolveConfig(options);
  const config = configRef.current;

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [preferences] = useState<NotificationPreferences>(() =>
    loadPreferences(config.storageKey, config.defaultPreferences)
  );
  const eventSourceRef = useRef<NotificationStreamHandle | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { api, endpoints, maxItems, reconnectDelayMs } = config;

    // Fetch notification history
    const fetchHistory = async () => {
      try {
        const data = await api.get(endpoints.list);
        if (!cancelled) {
          setNotifications(toArray<Notification>(data));
        }
      } catch { /* ignore */ }
    };
    fetchHistory();

    // Connect to SSE stream
    if (!preferences.enabled) return;

    const connectSSE = () => {
      if (cancelled) return;
      if (eventSourceRef.current) eventSourceRef.current.close();

      const es = api.stream(endpoints.stream, (data) => {
        try {
          const notification = data as Notification;
          if (preferences.types[notification.type] === false) return;
          setNotifications(prev => {
            if (prev.some(n => n.id === notification.id)) return prev;
            return [notification, ...prev].slice(0, maxItems);
          });
        } catch { /* ignore */ }
      }, {
        onError: () => {
          es.close();
          eventSourceRef.current = null;
          reconnectTimeoutRef.current = setTimeout(connectSSE, reconnectDelayMs);
        },
      });
      eventSourceRef.current = es;
    };
    connectSSE();

    return () => {
      cancelled = true;
      if (eventSourceRef.current) { eventSourceRef.current.close(); eventSourceRef.current = null; }
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [preferences.enabled, preferences.types, config]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const markAsRead = useCallback(async (id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    try { await config.api.post(config.endpoints.markRead(id)); } catch { /* ignore */ }
  }, [config]);

  const markAllAsRead = useCallback(async () => {
    const unreadIds = notifications.filter(n => !n.read).map(n => n.id);
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    for (const id of unreadIds) {
      try { await config.api.post(config.endpoints.markRead(id)); } catch { /* ignore */ }
    }
  }, [notifications, config]);

  return { notifications, unreadCount, markAsRead, markAllAsRead, preferences };
}
