/**
 * Thin, table-agnostic Supabase (PostgREST) REST wrapper.
 *
 * Ported from dev-dashboard-v2 server/lib/supabase.ts with the product
 * coupling removed:
 *   - URL / service-role key / correlation-id provider are constructor config
 *     (no env reads, no request-context import)
 *   - all hardcoded table helpers (dashboard_state, dashboard_activity,
 *     sso_configurations, dd_embeddings, ...) were dropped — the table name is
 *     always a parameter
 *   - the RLS-stage tenant RPC (rpcAsTenant) stayed behind: it depends on the
 *     project's rls-jwt module
 *
 * The instance shape (get / insert / patch / delete) structurally satisfies
 * the DalClient interface expected by @torihanaku/persistence.
 */

export interface DbResult {
  ok: boolean;
  data?: unknown[];
  error?: string;
  status?: number;
}

export interface SupabaseDalConfig {
  /** Supabase project URL (or pooler URL), e.g. "https://xxxx.supabase.co" — no trailing slash. */
  url: string;
  /** Service-role (or anon) API key. Inject the VALUE from your secret store; never hardcode it. */
  serviceRoleKey: string;
  /**
   * Correlation-id provider (e.g. request-scoped id from AsyncLocalStorage).
   * When set, every request carries an "X-Correlation-Id" header and error
   * logs include `request_id`. When omitted, the header is not sent.
   */
  getCorrelationId?: () => string;
  /** Custom fetch implementation (default: globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Escape special PostgREST filter characters to prevent injection.
 * Apply to any user-supplied string used in ilike/eq/or filters.
 */
export function escapePostgrestValue(val: string): string {
  return val.replace(/[%_\\,().*]/g, (c) => `\\${c}`);
}

/**
 * Reject Storage object paths that could escape the `object/{bucket}/` prefix.
 *
 * A `path` like `../../other-bucket/file` collapses under URL normalization
 * (`.../storage/v1/object/mybucket/../../other-bucket/file` →
 * `.../storage/v1/other-bucket/file`), letting a caller read/write outside the
 * intended bucket — a cross-tenant traversal with the service-role key (RLS
 * cannot mediate object storage). We forbid `.`/`..` segments, backslashes and
 * absolute paths rather than silently normalizing, so callers get a clear error.
 *
 * @throws Error when the path is unsafe.
 */
export function assertSafeStoragePath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("invalid storage path: must be a non-empty string");
  }
  // Normalize backslashes (Windows-style) so they can't smuggle traversal.
  if (path.includes("\\")) {
    throw new Error(`invalid storage path: backslash not allowed: ${path}`);
  }
  // Reject absolute paths (leading slash) — would also escape the prefix.
  if (path.startsWith("/")) {
    throw new Error(`invalid storage path: must be relative: ${path}`);
  }
  // Reject any "." or ".." path segment (the traversal primitives).
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(`invalid storage path: traversal segment not allowed: ${path}`);
    }
  }
}

export class SupabaseDal {
  constructor(private readonly config: SupabaseDalConfig) {}

  /** The configured Supabase base URL. */
  get url(): string {
    return this.config.url;
  }

  /** Base headers (apikey / Authorization / Content-Type), without correlation id. */
  get baseHeaders(): Record<string, string> {
    return {
      "apikey": this.config.serviceRoleKey,
      "Authorization": `Bearer ${this.config.serviceRoleKey}`,
      "Content-Type": "application/json",
    };
  }

  /** Headers with correlation ID (when a provider is configured). */
  private getHeaders(): Record<string, string> {
    const headers = this.baseHeaders;
    const correlationId = this.config.getCorrelationId?.();
    if (correlationId) headers["X-Correlation-Id"] = correlationId;
    return headers;
  }

  private requestId(): string | undefined {
    return this.config.getCorrelationId?.();
  }

  private doFetch(url: string, init?: RequestInit): Promise<Response> {
    const f = this.config.fetch ?? globalThis.fetch;
    return f(url, init);
  }

  // ─── Generic table helpers ──────────────────────────────────────────────────

  /** SELECT: GET /rest/v1/{table}?{query}. Returns rows, or null on any failure. */
  async get(table: string, query = ""): Promise<unknown[] | null> {
    try {
      const res = await this.doFetch(
        `${this.config.url}/rest/v1/${table}?${query}`,
        { headers: this.getHeaders() }
      );
      if (res.ok) return await res.json() as unknown[];
    } catch { /* ignore */ }
    return null;
  }

  /** INSERT (Prefer: return=minimal). */
  async insert(table: string, data: Record<string, unknown>): Promise<DbResult> {
    try {
      const res = await this.doFetch(
        `${this.config.url}/rest/v1/${table}`,
        {
          method: "POST",
          headers: { ...this.getHeaders(), "Prefer": "return=minimal" },
          body: JSON.stringify(data),
        }
      );
      if (res.ok) return { ok: true };
      const errText = await res.text().catch(() => "");
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_insert_failed", table, status: res.status, error: errText, request_id: this.requestId() }));
      return { ok: false, error: errText, status: res.status };
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_insert_exception", table, error: error.message, request_id: this.requestId() }));
      return { ok: false, error: error.message };
    }
  }

  /** INSERT して挿入後のレコードを返す（Prefer: return=representation） */
  async insertReturning(table: string, data: Record<string, unknown>): Promise<DbResult> {
    try {
      const res = await this.doFetch(
        `${this.config.url}/rest/v1/${table}`,
        {
          method: "POST",
          headers: { ...this.getHeaders(), "Prefer": "return=representation" },
          body: JSON.stringify(data),
        }
      );
      if (res.ok) {
        const rows = await res.json() as unknown[];
        return { ok: true, data: rows };
      }
      const errText = await res.text().catch(() => "");
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_insert_returning_failed", table, status: res.status, error: errText, request_id: this.requestId() }));
      return { ok: false, error: errText, status: res.status };
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_insert_returning_exception", table, error: error.message, request_id: this.requestId() }));
      return { ok: false, error: error.message };
    }
  }

  /** UPDATE rows matching `filter` (PostgREST filter string, e.g. "id=eq.1"). */
  async patch(table: string, filter: string, data: Record<string, unknown>): Promise<DbResult> {
    try {
      const res = await this.doFetch(
        `${this.config.url}/rest/v1/${table}?${filter}`,
        {
          method: "PATCH",
          headers: { ...this.getHeaders(), "Prefer": "return=minimal" },
          body: JSON.stringify(data),
        }
      );
      if (res.ok) return { ok: true };
      const errText = await res.text().catch(() => "");
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_patch_failed", table, status: res.status, error: errText, request_id: this.requestId() }));
      return { ok: false, error: errText, status: res.status };
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_patch_exception", table, error: error.message, request_id: this.requestId() }));
      return { ok: false, error: error.message };
    }
  }

  /** DELETE rows matching `filter`. */
  async delete(table: string, filter: string): Promise<DbResult> {
    try {
      const res = await this.doFetch(
        `${this.config.url}/rest/v1/${table}?${filter}`,
        {
          method: "DELETE",
          headers: { ...this.getHeaders(), "Prefer": "return=minimal" },
        }
      );
      if (res.ok) return { ok: true };
      const errText = await res.text().catch(() => "");
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_delete_failed", table, status: res.status, error: errText, request_id: this.requestId() }));
      return { ok: false, error: errText, status: res.status };
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_delete_exception", table, error: error.message, request_id: this.requestId() }));
      return { ok: false, error: error.message };
    }
  }

  // ─── Storage helpers ────────────────────────────────────────────────────────

  /** Upload an object to Supabase Storage (upsert enabled). */
  async upload(bucket: string, path: string, body: BodyInit, contentType: string): Promise<DbResult> {
    try {
      assertSafeStoragePath(bucket);
      assertSafeStoragePath(path);
      const res = await this.doFetch(
        `${this.config.url}/storage/v1/object/${bucket}/${path}`,
        {
          method: "POST",
          headers: {
            ...this.getHeaders(),
            "Content-Type": contentType,
            "x-upsert": "true",
          },
          body,
        }
      );
      if (res.ok) return { ok: true };
      const errText = await res.text().catch(() => "");
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_storage_upload_failed", bucket, path, status: res.status, error: errText, request_id: this.requestId() }));
      return { ok: false, error: errText, status: res.status };
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_storage_upload_exception", bucket, path, error: error.message, request_id: this.requestId() }));
      return { ok: false, error: error.message };
    }
  }

  /** Download an object from Supabase Storage. Returns the raw Response, or null. */
  async download(bucket: string, path: string): Promise<Response | null> {
    try {
      assertSafeStoragePath(bucket);
      assertSafeStoragePath(path);
      const res = await this.doFetch(
        `${this.config.url}/storage/v1/object/${bucket}/${path}`,
        { headers: this.getHeaders() }
      );
      if (res.ok) return res;
      const errText = await res.text().catch(() => "");
      console.warn(JSON.stringify({ severity: "WARNING", message: "supabase_storage_download_failed", bucket, path, status: res.status, error: errText, request_id: this.requestId() }));
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_storage_download_exception", bucket, path, error: error.message, request_id: this.requestId() }));
    }
    return null;
  }

  // ─── RPC (PostgreSQL function calls) ────────────────────────────────────────

  /**
   * Call a PostgreSQL function via PostgREST RPC endpoint.
   * POST /rest/v1/rpc/{fn}
   */
  async rpc<T = unknown>(
    fn: string,
    params: Record<string, unknown>
  ): Promise<T | null> {
    try {
      const res = await this.doFetch(`${this.config.url}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { ...this.baseHeaders, "Prefer": "return=representation" },
        body: JSON.stringify(params),
      });
      if (res.ok) return await res.json() as T;
      const errText = await res.text().catch(() => "");
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_rpc_failed", fn, status: res.status, error: errText }));
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(JSON.stringify({ severity: "ERROR", message: "supabase_rpc_exception", fn, error: error.message }));
    }
    return null;
  }
}

/** Factory — `createSupabaseDal({ url, serviceRoleKey })`. */
export function createSupabaseDal(config: SupabaseDalConfig): SupabaseDal {
  return new SupabaseDal(config);
}
