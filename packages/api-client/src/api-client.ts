/**
 * Centralized API client for all backend calls.
 *
 * - Injects a bearer token via an injected async `getToken()` callback
 * - Handles JSON serialization/deserialization
 * - Throws ApiError on non-OK responses (callers use try/catch)
 * - Provides typed methods: get, post, patch, put, del, upload, stream, sendBeacon, raw
 *
 * Ported from 実運用SaaS `src/lib/api-client.ts`.
 * Product coupling removed:
 *   - Supabase JWT acquisition  -> injected `getToken()` / `getStreamToken()`
 *   - `globalThis.__showToast`  -> injected `onError` / `onUsageLimit` callbacks
 *   - hardcoded `/api` prefix   -> `baseUrl` config (default `/api`)
 */

// --- Error class ---

export class ApiError extends Error {
  status: number;
  statusText: string;
  body: unknown;

  constructor(status: number, statusText: string, body: unknown) {
    super(`API ${status}: ${statusText}`);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

/** Returns true when the server rejected the request because ANTHROPIC_API_KEY is not configured. */
export function isAiNotConfigured(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  const body = e.body as Record<string, unknown> | null;
  return typeof body === 'object' && body !== null && body.error === 'ANTHROPIC_API_KEY not set';
}

// --- Config ---

/** Body shape the server returns for `usage_limit_exceeded` 403 responses. */
export interface UsageLimitDetails {
  error: 'usage_limit_exceeded';
  action?: unknown;
  used?: unknown;
  limit?: unknown;
  [key: string]: unknown;
}

export interface ApiClientConfig {
  /** URL prefix for every request. Default: `/api`. */
  baseUrl?: string;
  /**
   * Returns the bearer token (or null when unauthenticated).
   * Injected instead of the original Supabase `auth.getSession()` call.
   */
  getToken?: () => Promise<string | null> | string | null;
  /**
   * Synchronous token getter for `stream()` (the EventSource constructor is
   * sync, so an async `getToken` cannot be awaited there). The original read
   * the Supabase token from localStorage; inject the equivalent here.
   */
  getStreamToken?: () => string | null;
  /** Timeout applied when the caller passes no AbortSignal. Default: 8000ms. */
  timeoutMs?: number;
  /** UI feedback for permission errors (original showed a toast on plain 403). */
  onError?: (message: string, error: ApiError) => void;
  /** UI feedback when the server responds 403 `usage_limit_exceeded`. */
  onUsageLimit?: (message: string, details: UsageLimitDetails) => void;
}

// --- API Client factory ---

export function createApiClient(config: ApiClientConfig = {}) {
  const API_PREFIX = config.baseUrl ?? '/api';
  const timeoutMs = config.timeoutMs ?? 8_000;

  async function getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (config.getToken) {
      const token = await config.getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  async function request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      signal?: AbortSignal;
      headers?: Record<string, string>;
      rawResponse?: boolean;
      credentials?: RequestCredentials;
    },
  ): Promise<T> {
    const url = `${API_PREFIX}${path}`;
    const authHeaders = await getAuthHeaders();

    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...options?.headers,
      },
      signal: options?.signal,
    };

    if (options?.credentials) {
      init.credentials = options.credentials;
    }

    if (options?.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (!init.signal) {
      const controller = new AbortController();
      init.signal = controller.signal;
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { body = null; }
      const error = new ApiError(res.status, res.statusText, body);
      if (res.status === 403) {
        if (body && typeof body === 'object' && (body as Record<string, unknown>).error === 'usage_limit_exceeded') {
          const b = body as UsageLimitDetails;
          const msg = b.action
            ? `${b.action} の1日の上限（${b.used}/${b.limit}）に達しました`
            : `使用量の上限（${b.used}/${b.limit}）に達しました`;
          config.onUsageLimit?.(msg, b);
        } else {
          config.onError?.('この操作に必要な権限がありません', error);
        }
      }
      throw error;
    }

    // 204 No Content or empty body
    const text = await res.text();
    if (!text) return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** GET {baseUrl}{path} */
  async function get<T>(path: string, options?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<T> {
    return request<T>('GET', path, options);
  }

  /** POST {baseUrl}{path} with JSON body */
  async function post<T>(path: string, body?: unknown, options?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<T> {
    return request<T>('POST', path, { body, ...options });
  }

  /** PATCH {baseUrl}{path} with JSON body */
  async function patch<T>(path: string, body?: unknown, options?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<T> {
    return request<T>('PATCH', path, { body, ...options });
  }

  /** PUT {baseUrl}{path} with JSON body */
  async function put<T>(path: string, body?: unknown, options?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<T> {
    return request<T>('PUT', path, { body, ...options });
  }

  /** DELETE {baseUrl}{path} */
  async function del<T>(path: string, options?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<T> {
    return request<T>('DELETE', path, options);
  }

  /** Upload a file via FormData (no Content-Type header — browser sets multipart boundary) */
  async function upload<T>(path: string, formData: FormData, options?: { signal?: AbortSignal }): Promise<T> {
    const url = `${API_PREFIX}${path}`;
    const authHeaders = await getAuthHeaders();

    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders, // no Content-Type — browser adds multipart/form-data boundary
      body: formData,
      signal: options?.signal,
    });

    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { body = null; }
      throw new ApiError(res.status, res.statusText, body);
    }

    return res.json() as Promise<T>;
  }

  /** Open an EventSource (Server-Sent Events) stream with auth token as query param */
  function stream(
    path: string,
    onMessage: (data: unknown) => void,
    options?: { onError?: (e: Event) => void },
  ): EventSource {
    const url = new URL(`${API_PREFIX}${path}`, window.location.origin);

    // EventSource doesn't support custom headers, so pass token as query param.
    // Must be synchronous (EventSource constructor is sync) — see getStreamToken.
    if (config.getStreamToken) {
      try {
        const token = config.getStreamToken();
        if (token) url.searchParams.set('token', token);
      } catch { /* proceed without token */ }
    }

    const es = new EventSource(url.toString());
    es.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { onMessage(e.data); }
    };
    if (options?.onError) es.onerror = options.onError;
    return es;
  }

  /** Fire-and-forget beacon (for analytics — works even during page unload) */
  function sendBeacon(path: string, data: unknown): void {
    const url = `${API_PREFIX}${path}`;
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    navigator.sendBeacon(url, blob);
  }

  /** Raw fetch with auth headers (for cases needing full Response control) */
  async function raw(path: string, init?: RequestInit): Promise<Response> {
    const url = `${API_PREFIX}${path}`;
    const authHeaders = await getAuthHeaders();
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(authHeaders)) {
      if (!headers.has(k)) headers.set(k, v);
    }
    return fetch(url, { ...init, headers });
  }

  return { get, post, patch, put, del, upload, stream, sendBeacon, raw };
}

export type ApiClient = ReturnType<typeof createApiClient>;
