/**
 * React hook for live dashboard state: polling + SSE hybrid.
 *
 * - Polls a state endpoint on a fixed interval (fallback path).
 * - Additionally subscribes to an SSE stream and, on `state-change` events,
 *   re-fetches the state with a debounce (real-time path).
 * - If SSE is unsupported / fails, polling keeps everything working.
 *
 * Ported from dev-dashboard-v2 `src/hooks/useLiveState.ts` (104 LOC).
 * Differences from the original:
 *   - app-wide `api` client → injectable fetch / EventSource-shaped API
 *   - endpoints / debounce / SSE event name → options (defaults preserve
 *     the original: `/api/state`, `/api/notifications/stream`, 300ms,
 *     "state-change")
 */
import { useState, useEffect, useCallback, useRef } from "react";

interface CharacterState {
  status: string;
  progress: number;
  currentTask: string;
  updatedAt: string;
}

interface TaskState {
  status: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface HistoryEntry {
  time: string;
  actor: string;
  action: string;
  task: string;
  detail: string;
}

export interface SessionInfo {
  sessionId: string;
  state: "working" | "idle" | "waiting";
  message: string;
  characterId: string;
  workingDir: string;
  updatedAt: string;
}

export interface LiveState {
  tasks: Record<string, TaskState>;
  characters: Record<string, CharacterState>;
  history: HistoryEntry[];
  sessions: SessionInfo[];
  updatedAt: string;
}

/** Minimal EventSource-like handle the hook needs. */
export interface LiveStateStreamHandle {
  addEventListener(type: string, listener: () => void): void;
  close(): void;
}

export interface LiveStateApi {
  /** GET the state endpoint, returning parsed JSON. */
  get(path: string): Promise<Record<string, unknown>>;
  /** Open an SSE stream. May throw when EventSource is unsupported. */
  stream(
    path: string,
    onMessage: (data: unknown) => void,
    options?: { onError?: (e: Event) => void }
  ): LiveStateStreamHandle;
}

export interface UseLiveStateOptions {
  /** Client API. Default: fetch/EventSource-based implementation. */
  api?: LiveStateApi;
  endpoints?: {
    /** Polled state endpoint. Default: "/api/state". */
    state?: string;
    /** SSE stream endpoint. Default: "/api/notifications/stream". */
    stream?: string;
  };
  /** Debounce for SSE-triggered refetches, in ms. Default: 300. */
  debounceMs?: number;
  /** SSE event name that signals a state change. Default: "state-change". */
  stateChangeEvent?: string;
}

export function createDefaultLiveStateApi(config: {
  fetcher?: typeof fetch;
  createEventSource?: (url: string) => EventSource;
} = {}): LiveStateApi {
  const {
    fetcher = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    createEventSource = (url: string) => new EventSource(url),
  } = config;
  return {
    async get(path: string): Promise<Record<string, unknown>> {
      const res = await fetcher(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    },
    stream(path, onMessage, options): LiveStateStreamHandle {
      const es = createEventSource(path);
      es.onmessage = (e: MessageEvent) => {
        try { onMessage(JSON.parse(e.data as string)); } catch { onMessage(e.data); }
      };
      if (options?.onError) es.onerror = options.onError;
      return es;
    },
  };
}

const EMPTY_STATE: LiveState = { tasks: {}, characters: {}, history: [], sessions: [], updatedAt: "" };

export function useLiveState(intervalMs = 60000, options: UseLiveStateOptions = {}) {
  // Captured on first render so the effect keeps a stable dependency
  // (the original imported a module-level `api`).
  const configRef = useRef<{
    api: LiveStateApi;
    stateEndpoint: string;
    streamEndpoint: string;
    debounceMs: number;
    stateChangeEvent: string;
  } | null>(null);
  if (configRef.current === null) {
    configRef.current = {
      api: options.api ?? createDefaultLiveStateApi(),
      stateEndpoint: options.endpoints?.state ?? "/api/state",
      streamEndpoint: options.endpoints?.stream ?? "/api/notifications/stream",
      debounceMs: options.debounceMs ?? 300,
      stateChangeEvent: options.stateChangeEvent ?? "state-change",
    };
  }
  const config = configRef.current;

  const [state, setState] = useState<LiveState>(EMPTY_STATE);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const data = await config.api.get(config.stateEndpoint);
      setState({
        tasks: (data.tasks || {}) as Record<string, { status: string; completedAt?: string; updatedAt?: string }>,
        characters: (data.characters || {}) as Record<string, { status: string; progress: number; currentTask: string; updatedAt: string }>,
        history: (data.history || []) as HistoryEntry[],
        sessions: (data.sessions || []) as SessionInfo[],
        updatedAt: (data.updatedAt || "") as string,
      });
    } catch {
      // silent
    }
  }, [config]);

  const debouncedFetch = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      fetchState();
    }, config.debounceMs);
  }, [fetchState, config]);

  // Initial fetch outside of effect
  const hasFetched = useRef<boolean>(null);
  if (hasFetched.current == null) {
    hasFetched.current = true;
    fetchState();
  }

  useEffect(() => {
    // Polling fallback
    const interval = setInterval(fetchState, intervalMs);

    // SSE for real-time updates
    let es: LiveStateStreamHandle | null = null;
    try {
      es = config.api.stream(config.streamEndpoint, () => {
        // default messages handled via state-change event below
      }, {
        onError: () => {
          // SSE connection lost — polling fallback continues
        },
      });
      es.addEventListener(config.stateChangeEvent, () => {
        debouncedFetch();
      });
    } catch {
      // EventSource not supported or connection failed — polling fallback continues
    }

    return () => {
      clearInterval(interval);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (es) es.close();
    };
  }, [intervalMs, fetchState, debouncedFetch, config]);

  return state;
}
