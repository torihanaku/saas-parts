import { describe, expect, it } from "vitest";
import { createNotificationsHandler } from "./handler";
import { createInMemoryNotificationStore } from "./memory-store";
import type { DashboardNotification } from "./types";

const BASE = "http://localhost/api/notifications";

function makeHandler(overrides: Parameters<typeof createNotificationsHandler>[0] extends infer T
  ? Partial<T> : never = {}) {
  const store = createInMemoryNotificationStore();
  const handler = createNotificationsHandler({ store, ...overrides });
  return { store, handler };
}

async function createOne(
  handler: ReturnType<typeof createNotificationsHandler>,
  body: Record<string, unknown>
): Promise<{ res: Response; json: { id?: string; ok?: boolean; error?: string } }> {
  const res = (await handler(
    new Request(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  ))!;
  return { res, json: await res.json() };
}

describe("createNotificationsHandler", () => {
  it("returns null for unrelated paths", async () => {
    const { handler } = makeHandler();
    const res = await handler(new Request("http://localhost/api/other"));
    expect(res).toBeNull();
  });

  it("creates a notification and lists it (defaults applied)", async () => {
    const { handler } = makeHandler();
    const { res, json } = await createOne(handler, { title: "  件名  ", message: "本文" });
    expect(res.status).toBe(201);
    expect(json.ok).toBe(true);
    expect(json.id).toMatch(/^[0-9a-f-]{36}$/i);

    const listRes = (await handler(new Request(BASE)))!;
    const rows = (await listRes.json()) as DashboardNotification[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "件名",
      message: "本文",
      type: "info",
      target: "all",
      status: "pending",
      action_url: null,
    });
  });

  it("rejects missing title / message and invalid JSON", async () => {
    const { handler } = makeHandler();
    const noTitle = await createOne(handler, { message: "m" });
    expect(noTitle.res.status).toBe(400);
    expect(noTitle.json.error).toBe("title is required");

    const noMessage = await createOne(handler, { title: "t" });
    expect(noMessage.res.status).toBe(400);
    expect(noMessage.json.error).toBe("message is required");

    const badJson = (await handler(
      new Request(BASE, { method: "POST", body: "{oops" })
    ))!;
    expect(badJson.status).toBe(400);
  });

  it("truncates title/message and normalises unknown type/target", async () => {
    const { handler, store } = makeHandler();
    await createOne(handler, {
      title: "x".repeat(600),
      message: "y".repeat(3000),
      type: "bogus",
      target: "bogus",
    });
    const [row] = store.dump();
    expect(row!.title).toHaveLength(500);
    expect(row!.message).toHaveLength(2000);
    expect(row!.type).toBe("info");
    expect(row!.target).toBe("all");
  });

  it("counts pending notifications", async () => {
    const { handler } = makeHandler();
    await createOne(handler, { title: "a", message: "1" });
    await createOne(handler, { title: "b", message: "2" });
    const res = (await handler(new Request(`${BASE}/count`)))!;
    expect(await res.json()).toEqual({ count: 2 });
  });

  it("marks as read via PATCH /:id/read and reflects in count", async () => {
    const { handler, store } = makeHandler();
    const { json } = await createOne(handler, { title: "a", message: "1" });

    const res = (await handler(
      new Request(`${BASE}/${json.id}/read`, { method: "PATCH" })
    ))!;
    expect(await res.json()).toEqual({ ok: true });

    const [row] = store.dump();
    expect(row!.status).toBe("read");
    expect(row!.read_at).toBeTruthy();

    const countRes = (await handler(new Request(`${BASE}/count`)))!;
    expect(await countRes.json()).toEqual({ count: 0 });
  });

  it("soft-deletes via DELETE /:id (record kept for audit trail)", async () => {
    const { handler, store } = makeHandler();
    const { json } = await createOne(handler, { title: "a", message: "1" });

    const res = (await handler(
      new Request(`${BASE}/${json.id}`, { method: "DELETE" })
    ))!;
    expect(await res.json()).toEqual({ ok: true });
    expect(store.dump()[0]!.status).toBe("deleted");

    const listRes = (await handler(new Request(`${BASE}?status=all`)))!;
    expect(await listRes.json()).toEqual([]);
  });

  it("rejects non-UUID ids on read/delete", async () => {
    const { handler } = makeHandler();
    const patchRes = (await handler(
      new Request(`${BASE}/not-a-uuid/read`, { method: "PATCH" })
    ))!;
    expect(patchRes.status).toBe(400);

    const delRes = (await handler(
      new Request(`${BASE}/12345`, { method: "DELETE" })
    ))!;
    expect(delRes.status).toBe(400);
  });

  it("filters by status and clamps limit to 200", async () => {
    const store = createInMemoryNotificationStore();
    const calls: Array<{ status: string; limit: number }> = [];
    const spyStore = {
      ...store,
      list: async (o: { status: "pending" | "read" | "all"; limit: number }) => {
        calls.push(o);
        return store.list(o);
      },
    };
    const handler = createNotificationsHandler({ store: spyStore });
    await handler(new Request(`${BASE}?status=read&limit=999`));
    await handler(new Request(`${BASE}?status=weird`));
    expect(calls[0]).toEqual({ status: "read", limit: 200 });
    expect(calls[1]).toEqual({ status: "pending", limit: 50 });
  });

  it("enforces the injected authorize gate on CRUD endpoints", async () => {
    const forbidden = () => Response.json({ error: "forbidden" }, { status: 403 });
    const { handler } = makeHandler({ authorize: forbidden });

    for (const req of [
      new Request(BASE),
      new Request(`${BASE}/count`),
      new Request(BASE, { method: "POST", body: "{}" }),
      new Request(`${BASE}/6f9619ff-8b86-4d01-b42d-00c04fc964ff/read`, { method: "PATCH" }),
      new Request(`${BASE}/6f9619ff-8b86-4d01-b42d-00c04fc964ff`, { method: "DELETE" }),
    ]) {
      const res = (await handler(req))!;
      expect(res.status).toBe(403);
    }
  });

  it("returns safe fallbacks when the store throws (list [], count 0)", async () => {
    const logs: Record<string, unknown>[] = [];
    const broken = {
      list: async () => { throw new Error("db down"); },
      countPending: async () => { throw new Error("db down"); },
      insert: async () => ({ ok: false as const, error: "db down" }),
      update: async () => ({ ok: false as const, error: "db down" }),
    };
    const handler = createNotificationsHandler({ store: broken, log: (e) => logs.push(e) });

    const listRes = (await handler(new Request(BASE)))!;
    expect(await listRes.json()).toEqual([]);
    const countRes = (await handler(new Request(`${BASE}/count`)))!;
    expect(await countRes.json()).toEqual({ count: 0 });

    const createRes = (await handler(
      new Request(BASE, { method: "POST", body: JSON.stringify({ title: "t", message: "m" }) })
    ))!;
    expect(createRes.status).toBe(500);
    expect(logs.some((l) => l.message === "notifications_list_failed")).toBe(true);
  });

  it("serves an SSE stream with heartbeat headers and registers the client", async () => {
    const sseClients = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const { handler } = makeHandler({ sseClients, corsOrigin: "https://app.example" });

    const controller = new AbortController();
    const res = (await handler(
      new Request(`${BASE}/stream`, { signal: controller.signal })
    ))!;
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain(": heartbeat");
    expect(sseClients.size).toBe(1);

    controller.abort();
    // Aborting unregisters the client and closes the stream
    await new Promise((r) => setTimeout(r, 0));
    expect(sseClients.size).toBe(0);
  });

  it("respects a custom basePath", async () => {
    const store = createInMemoryNotificationStore();
    const handler = createNotificationsHandler({ store, basePath: "/api/v2/notices" });
    const res = (await handler(
      new Request("http://localhost/api/v2/notices", {
        method: "POST",
        body: JSON.stringify({ title: "t", message: "m" }),
      })
    ))!;
    expect(res.status).toBe(201);
    expect(await handler(new Request(BASE))).toBeNull();
  });
});
