/**
 * Notification routes: CRUD API for dashboard in-app notifications.
 *
 * Ported from 実運用SaaS `server/routes/notifications.ts` (246 LOC).
 * Framework-free: the handler takes a `Request` and returns a `Response`,
 * or `null` when the request does not match any notification endpoint.
 *
 * Endpoints (relative to `basePath`, default `/api/notifications`):
 *   GET    {base}           — list (status filter, limit)
 *   GET    {base}/count     — unread count (badge)
 *   POST   {base}           — create notification (internal service → dashboard)
 *   PATCH  {base}/:id/read  — mark as read
 *   DELETE {base}/:id       — soft-delete
 *   GET    {base}/stream    — SSE heartbeat stream (legacy)
 *
 * Differences from the original:
 *   - Supabase calls → injected `NotificationStore`
 *   - `requireRole(req, "admin", "editor")` → injected `authorize` predicate
 *   - CORS origin / heartbeat interval / sseClients map / clock / uuid → options
 */
import type {
  DashboardNotification,
  NotificationsHandlerOptions,
  NotificationStatusFilter,
} from "./types";

interface CreateNotificationBody {
  title?: unknown;
  message?: unknown;
  type?: unknown;
  target?: unknown;
  action_url?: unknown;
  metadata?: unknown;
}

// ─── Validation ─────────────────────────────────────────────────

const VALID_TYPES = new Set(["alert", "info", "warning", "success"]);
const VALID_TARGETS = new Set(["all", "admin", "editor"]);
const VALID_STATUSES = new Set(["pending", "read", "all"]);

function sanitizeId(raw: string): string {
  // UUID format validation — reject anything that isn't a valid UUID
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new Error("Invalid notification ID format");
  }
  return raw;
}

// ─── Handler factory ────────────────────────────────────────────

export function createNotificationsHandler(options: NotificationsHandlerOptions) {
  const {
    store,
    authorize = () => null,
    basePath = "/api/notifications",
    corsOrigin = "*",
    heartbeatIntervalMs = 30000,
    sseClients = new Map<string, ReadableStreamDefaultController<Uint8Array>>(),
    log = (entry) => console.error(JSON.stringify(entry)),
    now = () => new Date(),
    generateId = () => crypto.randomUUID(),
  } = options;

  const escapedBase = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const readPattern = new RegExp(`^${escapedBase}/([^/]+)/read$`);
  const deletePattern = new RegExp(`^${escapedBase}/([^/]+)$`);

  return async function handleNotificationsRoutes(
    req: Request,
    pathname?: string
  ): Promise<Response | null> {
    const path = pathname ?? new URL(req.url).pathname;

    // ── SSE stream (legacy — kept for backward compatibility) ──────
    if (req.method === "GET" && path === `${basePath}/stream`) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
          const clientId = generateId();
          sseClients.set(clientId, controller);
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            } catch {
              clearInterval(heartbeat);
              sseClients.delete(clientId);
            }
          }, heartbeatIntervalMs);
          req.signal.addEventListener("abort", () => {
            clearInterval(heartbeat);
            sseClients.delete(clientId);
            try { controller.close(); } catch { /* already closed */ }
          });
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": corsOrigin,
        },
      });
    }

    // ── GET {base}/count ──────────────────────────────────────────
    if (req.method === "GET" && path === `${basePath}/count`) {
      const forbidden = await authorize(req);
      if (forbidden) return forbidden;

      try {
        const count = await store.countPending();
        return Response.json({ count });
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        log({ severity: "ERROR", message: "notifications_count_failed", error, path });
        return Response.json({ count: 0 });
      }
    }

    // ── GET {base} ────────────────────────────────────────────────
    if (req.method === "GET" && path === basePath) {
      const forbidden = await authorize(req);
      if (forbidden) return forbidden;

      try {
        const urlObj = new URL(req.url);
        const statusParam = urlObj.searchParams.get("status") ?? "pending";
        const limitParam = parseInt(urlObj.searchParams.get("limit") ?? "50", 10);
        const limit = Math.min(isNaN(limitParam) ? 50 : limitParam, 200);

        const status: NotificationStatusFilter = VALID_STATUSES.has(statusParam)
          ? (statusParam as NotificationStatusFilter)
          : "pending";

        const rows = await store.list({ status, limit });
        return Response.json(rows ?? []);
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        log({ severity: "ERROR", message: "notifications_list_failed", error, path });
        return Response.json([]);
      }
    }

    // ── POST {base} ───────────────────────────────────────────────
    if (req.method === "POST" && path === basePath) {
      const forbidden = await authorize(req);
      if (forbidden) return forbidden;

      let body: CreateNotificationBody;
      try {
        body = await req.json() as CreateNotificationBody;
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      if (typeof body.title !== "string" || !body.title.trim()) {
        return Response.json({ error: "title is required" }, { status: 400 });
      }
      if (typeof body.message !== "string" || !body.message.trim()) {
        return Response.json({ error: "message is required" }, { status: 400 });
      }
      const type = typeof body.type === "string" && VALID_TYPES.has(body.type)
        ? body.type as DashboardNotification["type"]
        : "info";
      const target = typeof body.target === "string" && VALID_TARGETS.has(body.target)
        ? body.target as DashboardNotification["target"]
        : "all";

      const record: DashboardNotification = {
        id: generateId(),
        title: String(body.title).trim().slice(0, 500),
        message: String(body.message).trim().slice(0, 2000),
        type,
        target,
        status: "pending",
        action_url: typeof body.action_url === "string" ? body.action_url.slice(0, 2000) : null,
        metadata: body.metadata && typeof body.metadata === "object"
          ? body.metadata as Record<string, unknown>
          : null,
        created_at: now().toISOString(),
        read_at: null,
      };

      const result = await store.insert(record);
      if (!result.ok) {
        log({ severity: "ERROR", message: "notification_create_failed", error: result.error, path });
        return Response.json({ error: "Failed to create notification" }, { status: 500 });
      }

      return Response.json({ id: record.id, ok: true }, { status: 201 });
    }

    // ── PATCH {base}/:id/read ─────────────────────────────────────
    const readMatch = path.match(readPattern);
    if (req.method === "PATCH" && readMatch) {
      const forbidden = await authorize(req);
      if (forbidden) return forbidden;

      let notifId: string;
      try {
        notifId = sanitizeId(readMatch[1] ?? "");
      } catch {
        return Response.json({ error: "Invalid notification ID" }, { status: 400 });
      }

      const result = await store.update(notifId, {
        status: "read",
        read_at: now().toISOString(),
      });

      if (!result.ok) {
        log({ severity: "ERROR", message: "notification_mark_read_failed", error: result.error, id: notifId, path });
        return Response.json({ error: "Failed to mark notification as read" }, { status: 500 });
      }

      return Response.json({ ok: true });
    }

    // ── DELETE {base}/:id ─────────────────────────────────────────
    const deleteMatch = path.match(deletePattern);
    if (req.method === "DELETE" && deleteMatch) {
      const forbidden = await authorize(req);
      if (forbidden) return forbidden;

      let notifId: string;
      try {
        notifId = sanitizeId(deleteMatch[1] ?? "");
      } catch {
        return Response.json({ error: "Invalid notification ID" }, { status: 400 });
      }

      // Soft delete: set status to "deleted" to preserve audit trail
      const result = await store.update(notifId, {
        status: "deleted",
        read_at: now().toISOString(),
      });

      if (!result.ok) {
        log({ severity: "ERROR", message: "notification_delete_failed", error: result.error, id: notifId, path });
        return Response.json({ error: "Failed to delete notification" }, { status: 500 });
      }

      return Response.json({ ok: true });
    }

    return null;
  };
}
