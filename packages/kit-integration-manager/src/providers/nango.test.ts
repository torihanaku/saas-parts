import { describe, it, expect, vi } from "vitest";
import { NangoProvider, pingNango, DEFAULT_NANGO_SERVER_URL } from "./nango";
import type { SecretStore } from "../types";

const FAKE_KEY = "fake-nango-key-for-tests";
const FAKE_TENANT_KEY = "fake-tenant-key-1234";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetch(body: unknown, status = 200) {
  return vi.fn(async () => jsonResponse(body, status)) as unknown as ReturnType<typeof vi.fn> &
    typeof fetch;
}

const store = (config: { secretKey: string; serverUrl?: string; enabled: boolean } | null): SecretStore => ({
  get: async () => config,
});

describe("NangoProvider config resolution", () => {
  it("uses tenant config from the injected SecretStore", async () => {
    const fetchFn = makeFetch({ connections: [] });
    const provider = new NangoProvider({
      secretStore: store({ secretKey: FAKE_TENANT_KEY, serverUrl: "https://nango.example.com", enabled: true }),
      fetch: fetchFn,
    });
    await provider.listConnections("t1");
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://nango.example.com/connections");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_TENANT_KEY}`);
  });

  it("falls back to default key when tenant config is disabled", async () => {
    const fetchFn = makeFetch({ connections: [] });
    const provider = new NangoProvider({
      defaultSecretKey: FAKE_KEY,
      secretStore: store({ secretKey: FAKE_TENANT_KEY, enabled: false }),
      fetch: fetchFn,
    });
    await provider.listConnections("t1");
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${DEFAULT_NANGO_SERVER_URL}/connections`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("returns empty/null results when nothing is configured", async () => {
    const fetchFn = makeFetch({ connections: [] });
    const provider = new NangoProvider({ fetch: fetchFn });
    expect(await provider.listConnections("t1")).toEqual([]);
    expect(await provider.triggerSync("t1", "slack", "c1")).toBe(false);
    expect(await provider.pollStatus("t1", "slack", "c1")).toBeNull();
    expect(await provider.connect("t1", { end_user: { id: "u1" } })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("isConfigured reflects presence of a default key", () => {
    expect(new NangoProvider({ defaultSecretKey: FAKE_KEY }).isConfigured()).toBe(true);
    expect(new NangoProvider().isConfigured()).toBe(false);
  });
});

describe("NangoProvider API calls", () => {
  it("listConnections filters by clientId using the connection-id convention", async () => {
    const fetchFn = makeFetch({
      connections: [
        { id: 1, connection_id: "client_a_slack", provider_config_key: "slack", provider: "slack", created_at: "2026-01-01" },
        { id: 2, connection_id: "client_b_slack", provider_config_key: "slack", provider: "slack", created_at: "2026-01-01" },
      ],
    });
    const provider = new NangoProvider({ defaultSecretKey: FAKE_KEY, fetch: fetchFn });
    const result = await provider.listConnections("t1", undefined, "a");
    expect(result).toHaveLength(1);
    expect(result[0]?.connection_id).toBe("client_a_slack");
  });

  it("triggerSync posts provider_config_key + connection_id", async () => {
    const fetchFn = makeFetch({});
    const provider = new NangoProvider({ defaultSecretKey: FAKE_KEY, fetch: fetchFn });
    expect(await provider.triggerSync("t1", "slack", "c1", ["messages"])).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_NANGO_SERVER_URL}/syncs/trigger`);
    expect(JSON.parse(String(init.body))).toEqual({
      provider_config_key: "slack",
      connection_id: "c1",
      syncs: ["messages"],
    });
  });

  it("fetchRecords sends model/limit/cursor and connection headers", async () => {
    const fetchFn = makeFetch({ records: [{ id: "r1" }], next_cursor: "abc" });
    const provider = new NangoProvider({ defaultSecretKey: FAKE_KEY, fetch: fetchFn });
    const result = await provider.fetchRecords("t1", "slack", "c1", "messages", { limit: 10, cursor: "cur" });
    expect(result.records).toHaveLength(1);
    expect(result.next_cursor).toBe("abc");
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("model=messages");
    expect(url).toContain("limit=10");
    expect(url).toContain("cursor=cur");
    const headers = init.headers as Record<string, string>;
    expect(headers["Connection-Id"]).toBe("c1");
    expect(headers["Provider-Config-Key"]).toBe("slack");
  });

  it("publish proxies through /proxy/{endpoint} with POST by default", async () => {
    const fetchFn = makeFetch({ ok: true });
    const provider = new NangoProvider({ defaultSecretKey: FAKE_KEY, fetch: fetchFn });
    const result = await provider.publish("t1", "slack", "c1", {
      endpoint: "/chat.postMessage",
      body: { channel: "#general", text: "hi" },
    });
    expect(result?.status).toBe(200);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_NANGO_SERVER_URL}/proxy//chat.postMessage`);
    expect(init.method).toBe("POST");
  });

  it("connect creates a session and returns the token", async () => {
    const fetchFn = makeFetch({ token: "sess_token" });
    const provider = new NangoProvider({ defaultSecretKey: FAKE_KEY, fetch: fetchFn });
    const session = await provider.connect("t1", { end_user: { id: "u1", email: "u@example.com" } });
    expect(session?.token).toBe("sess_token");
    const [url] = fetchFn.mock.calls[0] as [string];
    expect(url).toBe(`${DEFAULT_NANGO_SERVER_URL}/connect/sessions`);
  });

  it("returns safe fallbacks when the API errors", async () => {
    const fetchFn = makeFetch({ error: "boom" }, 500);
    const provider = new NangoProvider({ defaultSecretKey: FAKE_KEY, fetch: fetchFn });
    expect(await provider.listConnections("t1")).toEqual([]);
    expect(await provider.triggerSync("t1", "slack", "c1")).toBe(false);
    expect(await provider.pollStatus("t1", "slack", "c1")).toBeNull();
    expect(await provider.publish("t1", "slack", "c1", { endpoint: "/x" })).toBeNull();
    expect((await provider.fetchRecords("t1", "slack", "c1", "messages")).records).toEqual([]);
  });

  it("returns safe fallbacks when fetch throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const provider = new NangoProvider({ defaultSecretKey: FAKE_KEY, fetch: fetchFn });
    expect(await provider.listConnections("t1")).toEqual([]);
    expect(await provider.deleteConnection("t1", "slack", "c1")).toBe(false);
  });
});

describe("pingNango", () => {
  it("requires a secret key", async () => {
    const result = await pingNango("");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("returns ok on 200", async () => {
    const fetchFn = makeFetch({ configs: [] });
    const result = await pingNango(FAKE_KEY, DEFAULT_NANGO_SERVER_URL, fetchFn);
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("returns status and truncated body on failure", async () => {
    const fetchFn = makeFetch({ error: "unauthorized" }, 401);
    const result = await pingNango(FAKE_KEY, DEFAULT_NANGO_SERVER_URL, fetchFn);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("unauthorized");
  });
});
