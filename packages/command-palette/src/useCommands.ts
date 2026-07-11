/**
 * React hook for the command palette: fetch command history + submit
 * free-text commands to the backend.
 *
 * Ported from dev-dashboard-v2 `src/hooks/useCommands.ts` (72 LOC).
 * Differences from the original:
 *   - app-wide `api` client → injectable fetch-shaped API
 *   - endpoints → options (defaults preserve the original `/api/commands`
 *     and `/api/command`)
 *
 * The backend of the original (`POST /api/command` in
 * `server/routes/core-chat.ts`) is product-specific task creation
 * (GitHub issue creation / Anthropic Q&A / Supabase backlog insert),
 * so it is intentionally NOT extracted. See README for the API contract
 * a compatible backend must implement.
 */
import { useState, useEffect, useCallback, useRef } from "react";

export interface Command {
  id: string;
  text: string;
  assignee: string;
  repo: string;
  labels: string[];
  timestamp: string;
  issueUrl?: string;
}

export interface CommandsApi {
  /** GET a JSON resource (command history). */
  get(path: string): Promise<unknown>;
  /** POST a JSON body (submit a command). */
  post(path: string, body: unknown): Promise<unknown>;
}

export interface UseCommandsOptions {
  /** Client API. Default: fetch-based implementation. */
  api?: CommandsApi;
  endpoints?: {
    /** History endpoint. Default: "/api/commands". */
    list?: string;
    /** Command intake endpoint. Default: "/api/command". */
    send?: string;
  };
}

export function createDefaultCommandsApi(
  fetcher: typeof fetch = (...args) => globalThis.fetch(...args)
): CommandsApi {
  const parse = async (res: Response): Promise<unknown> => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text) return undefined;
    try { return JSON.parse(text); } catch { return text; }
  };
  return {
    get: async (path) => parse(await fetcher(path)),
    post: async (path, body) =>
      parse(await fetcher(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })),
  };
}

/**
 * Ported from dev-dashboard-v2 `src/utils/api.ts` — safely extract an array
 * from a raw response that may be `T[]`, `{ data: T[] }` or `{ items: T[] }`.
 */
export function toArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    if ("data" in data) {
      const d = (data as Record<string, unknown>).data;
      if (Array.isArray(d)) return d;
    }
    if ("items" in data) {
      const items = (data as Record<string, unknown>).items;
      if (Array.isArray(items)) return items;
    }
  }
  return [];
}

export function useCommands(options: UseCommandsOptions = {}) {
  // Captured on first render so callbacks/effects keep stable identities
  // (the original imported a module-level `api`).
  const configRef = useRef<{ api: CommandsApi; list: string; send: string } | null>(null);
  if (configRef.current === null) {
    configRef.current = {
      api: options.api ?? createDefaultCommandsApi(),
      list: options.endpoints?.list ?? "/api/commands",
      send: options.endpoints?.send ?? "/api/command",
    };
  }
  const config = configRef.current;

  const [commands, setCommands] = useState<Command[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchCommands = useCallback(async () => {
    try {
      const data = await config.api.get(config.list);
      setCommands(toArray<Command>(data));
    } catch {
      // fail silently
    }
  }, [config]);

  useEffect(() => {
    fetchCommands();
  }, [fetchCommands]);

  const sendCommand = useCallback(async (text: string) => {
    setLoading(true);
    try {
      await config.api.post(config.send, { text });
      await fetchCommands();
      return true;
    } catch {
      return false;
    } finally {
      setLoading(false);
    }
  }, [fetchCommands, config]);

  return { commands, sendCommand, loading, refetch: fetchCommands };
}
