/**
 * Shared server-side types for the in-app notification system.
 * Ported from dev-dashboard-v2 `server/routes/notifications.ts`.
 */

export interface DashboardNotification {
  id: string;
  title: string;
  message: string;
  type: "alert" | "info" | "warning" | "success";
  target: "all" | "admin" | "editor";
  status: "pending" | "read" | "deleted";
  action_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  read_at: string | null;
}

export type NotificationStatusFilter = "pending" | "read" | "all";

export interface StoreResult {
  ok: boolean;
  error?: string;
}

/**
 * Storage abstraction. The original implementation was bound to Supabase
 * (`supabaseGet` / `supabaseInsert` / `supabasePatch` on the
 * `dashboard_notifications` table); any persistence layer can be injected here.
 */
export interface NotificationStore {
  /** List notifications, newest first, filtered by status ("all" = no filter). */
  list(options: {
    status: NotificationStatusFilter;
    limit: number;
  }): Promise<DashboardNotification[]>;
  /** Count of notifications with status "pending" (unread badge). */
  countPending(): Promise<number>;
  /** Insert a fully-built notification record. */
  insert(record: DashboardNotification): Promise<StoreResult>;
  /** Partially update a notification by id. */
  update(
    id: string,
    patch: Partial<Pick<DashboardNotification, "status" | "read_at">>
  ): Promise<StoreResult>;
}

/**
 * Auth / role gate. Mirrors the original `requireRole(req, "admin", "editor")`
 * contract: return a `Response` (e.g. 401/403) to block the request, or
 * `null`/`undefined` to allow it.
 */
export type AuthorizeFn = (
  req: Request
) => Promise<Response | null | undefined> | Response | null | undefined;

/** Structured log sink. Defaults to `console.error(JSON.stringify(entry))`. */
export type LogFn = (entry: Record<string, unknown>) => void;

export interface NotificationsHandlerOptions {
  /** Persistence backend (required). See {@link createInMemoryNotificationStore}. */
  store: NotificationStore;
  /**
   * Role gate applied to every endpoint except the SSE stream (matching the
   * original, where the stream endpoint was not role-gated).
   * Default: allow all requests.
   */
  authorize?: AuthorizeFn;
  /** Base path for all endpoints. Default: "/api/notifications". */
  basePath?: string;
  /** Value for Access-Control-Allow-Origin on the SSE stream. Default: "*". */
  corsOrigin?: string;
  /** SSE heartbeat interval in ms. Default: 30000. */
  heartbeatIntervalMs?: number;
  /**
   * Registry of connected SSE clients, exposed so the host app can broadcast
   * events (the original kept this in a shared `sseClients` map in
   * `server/lib/state`). Default: a fresh internal Map.
   */
  sseClients?: Map<string, ReadableStreamDefaultController<Uint8Array>>;
  /** Structured error log sink. */
  log?: LogFn;
  /** Clock, injectable for tests. Default: `() => new Date()`. */
  now?: () => Date;
  /** Id generator. Default: `crypto.randomUUID()`. */
  generateId?: () => string;
}
