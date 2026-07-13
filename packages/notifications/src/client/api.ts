/**
 * Minimal client API abstraction consumed by `useNotifications`.
 *
 * The original hook depended on the app-wide `api` client
 * (`src/lib/api-client.ts`: get / post / stream with Supabase JWT injection).
 * Here the same call surface is defined as an interface, with a default
 * implementation built on injectable `fetch` / `EventSource` factories.
 */

export interface NotificationStreamHandle {
  close(): void;
}

export interface NotificationsClientApi {
  /** GET a JSON resource. */
  get(path: string): Promise<unknown>;
  /** Fire a state-changing request (mark-as-read). Response body is ignored. */
  post(path: string): Promise<unknown>;
  /** Open an SSE stream; `onMessage` receives JSON-parsed `message` events. */
  stream(
    path: string,
    onMessage: (data: unknown) => void,
    options?: { onError?: (e: Event) => void }
  ): NotificationStreamHandle;
}

export interface DefaultNotificationsApiConfig {
  /** Fetch implementation. Default: `globalThis.fetch`. */
  fetcher?: typeof fetch;
  /** EventSource factory. Default: `(url) => new EventSource(url)`. */
  createEventSource?: (url: string) => EventSource;
  /**
   * HTTP method used by `post()`. The original client used POST, but the
   * bundled server handler (ported as-is) expects PATCH for
   * `{base}/:id/read` — hence the default here is "PATCH".
   */
  postMethod?: string;
}

export function createDefaultNotificationsApi(
  config: DefaultNotificationsApiConfig = {}
): NotificationsClientApi {
  const {
    fetcher = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    createEventSource = (url: string) => new EventSource(url),
    postMethod = "PATCH",
  } = config;

  return {
    async get(path: string): Promise<unknown> {
      const res = await fetcher(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text) return undefined;
      try { return JSON.parse(text); } catch { return text; }
    },

    async post(path: string): Promise<unknown> {
      const res = await fetcher(path, { method: postMethod });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text) return undefined;
      try { return JSON.parse(text); } catch { return text; }
    },

    stream(path, onMessage, options): NotificationStreamHandle {
      const es = createEventSource(path);
      es.onmessage = (e: MessageEvent) => {
        try { onMessage(JSON.parse(e.data as string)); } catch { onMessage(e.data); }
      };
      if (options?.onError) es.onerror = options.onError;
      return es;
    },
  };
}

/**
 * Ported from 実運用SaaS `src/utils/api.ts` — safely extract an array
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
