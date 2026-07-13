/**
 * Tests — ported from 実運用SaaS tests/slack-user-mapping.test.ts.
 * env モック → ファクトリ引数、Supabase REST → createRestEmailLookup + fetch 注入。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSlackUserResolver, createRestEmailLookup, type SlackUserResolver } from "./user-mapping";

type MockResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

function mockFetchSequence(responses: MockResponse[]) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: r.json,
    });
  }
  return fn;
}

function buildResolver(fetchMock: ReturnType<typeof vi.fn>, botToken = "xoxb-test"): SlackUserResolver {
  return createSlackUserResolver({
    botToken,
    fetchImpl: fetchMock as unknown as typeof fetch,
    lookupUserByEmail: createRestEmailLookup({
      baseUrl: "https://example.supabase.co",
      serviceKey: "service-role-key",
      table: "dashboard_team_members",
      fetchImpl: fetchMock as unknown as typeof fetch,
      logWarn: () => {},
    }),
    logWarn: () => {},
  });
}

describe("SlackUserResolver.resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns app user ID when Slack returns email and lookup has the user", async () => {
    const fetchMock = mockFetchSequence([
      {
        ok: true,
        json: async () => ({ ok: true, user: { profile: { email: "alice@example.com" } } }),
      },
      { ok: true, json: async () => [{ id: "uuid-alice" }] },
    ]);

    const resolver = buildResolver(fetchMock);
    const id = await resolver.resolve("U123", "tenant-1");
    expect(id).toBe("uuid-alice");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("slack.com/api/users.info?user=U123");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("dashboard_team_members");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("tenant_id=eq.tenant-1");
  });

  it("returns null when Slack response has no email", async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, json: async () => ({ ok: true, user: { profile: {} } }) },
    ]);
    const resolver = buildResolver(fetchMock);
    const id = await resolver.resolve("U_noemail", "tenant-1");
    expect(id).toBeNull();
  });

  it("returns null when Slack API errors", async () => {
    const fetchMock = mockFetchSequence([{ ok: false, status: 500, json: async () => ({}) }]);
    const resolver = buildResolver(fetchMock);
    const id = await resolver.resolve("U_err", "tenant-1");
    expect(id).toBeNull();
  });

  it("returns null when lookup has no matching user", async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, json: async () => ({ ok: true, user: { profile: { email: "ghost@example.com" } } }) },
      { ok: true, json: async () => [] },
    ]);
    const resolver = buildResolver(fetchMock);
    const id = await resolver.resolve("U_ghost", "tenant-1");
    expect(id).toBeNull();
  });

  it("caches both positive and negative results within TTL", async () => {
    const fetchMock = mockFetchSequence([
      {
        ok: true,
        json: async () => ({ ok: true, user: { profile: { email: "bob@example.com" } } }),
      },
      { ok: true, json: async () => [{ id: "uuid-bob" }] },
    ]);

    const resolver = buildResolver(fetchMock);
    const first = await resolver.resolve("U_bob", "tenant-1");
    const second = await resolver.resolve("U_bob", "tenant-1");
    expect(first).toBe("uuid-bob");
    expect(second).toBe("uuid-bob");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after clearCache", async () => {
    const fetchMock = mockFetchSequence([
      { ok: true, json: async () => ({ ok: true, user: { profile: { email: "bob@example.com" } } }) },
      { ok: true, json: async () => [{ id: "uuid-bob" }] },
      { ok: true, json: async () => ({ ok: true, user: { profile: { email: "bob@example.com" } } }) },
      { ok: true, json: async () => [{ id: "uuid-bob-2" }] },
    ]);

    const resolver = buildResolver(fetchMock);
    expect(await resolver.resolve("U_bob", "tenant-1")).toBe("uuid-bob");
    resolver.clearCache();
    expect(await resolver.resolve("U_bob", "tenant-1")).toBe("uuid-bob-2");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns null when slackUserId or tenantId is empty", async () => {
    const fetchMock = vi.fn();
    const resolver = buildResolver(fetchMock);
    expect(await resolver.resolve("", "tenant-1")).toBeNull();
    expect(await resolver.resolve("U1", "")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolve without botToken (graceful)", () => {
  it("returns null and skips fetch when token is missing", async () => {
    const fetchMock = vi.fn();
    const resolver = createSlackUserResolver({
      botToken: undefined,
      fetchImpl: fetchMock as unknown as typeof fetch,
      lookupUserByEmail: async () => "should-not-be-called",
      logWarn: () => {},
    });
    const id = await resolver.resolve("U1", "tenant-1");
    expect(id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
