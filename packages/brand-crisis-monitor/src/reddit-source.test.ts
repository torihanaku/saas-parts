/**
 * Tests for createRedditSource (ported from 実運用SaaS brand-crisis-reddit.test.ts).
 * env 参照とグローバル fetch を注入式 config / fetchFn に置換。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createRedditSource, type FetchFn } from "./reddit-source";

type MockResp = { ok: boolean; status?: number; json: () => Promise<unknown> };

function makeFetch(responses: MockResp[]): ReturnType<typeof vi.fn> & FetchFn {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: r.json,
    });
  }
  return fn as unknown as ReturnType<typeof vi.fn> & FetchFn;
}

function makeSource(fetchFn: FetchFn) {
  return createRedditSource({
    clientId: "test-id",
    clientSecret: "test-secret",
    userAgent: "folia-test/1.0",
    fetchFn,
  });
}

describe("createRedditSource.search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns parsed mentions on a successful search", async () => {
    const fetchMock = makeFetch([
      { ok: true, json: async () => ({ access_token: "tok-1", expires_in: 3600 }) },
      {
        ok: true,
        json: async () => ({
          data: {
            children: [
              {
                kind: "t3",
                data: {
                  id: "abc",
                  title: "Folia is great",
                  selftext: "Loved using it for marketing.",
                  permalink: "/r/SaaS/comments/abc/",
                  subreddit: "SaaS",
                  author: "user1",
                  created_utc: 1716000000,
                },
              },
            ],
          },
        }),
      },
    ]);

    const source = makeSource(fetchMock);
    const mentions = await source.search("folia");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.external_id).toBe("reddit:abc");
    expect(mentions[0]!.permalink).toContain("https://www.reddit.com/r/SaaS");
    expect(mentions[0]!.content).toContain("Folia is great");
    expect(mentions[0]!.metadata?.subreddit).toBe("SaaS");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses the cached access token on a second call within TTL", async () => {
    const fetchMock = makeFetch([
      { ok: true, json: async () => ({ access_token: "tok-1", expires_in: 3600 }) },
      { ok: true, json: async () => ({ data: { children: [] } }) },
      { ok: true, json: async () => ({ data: { children: [] } }) },
    ]);

    const source = makeSource(fetchMock);
    await source.search("folia");
    await source.search("folia2");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns [] when token request fails", async () => {
    const fetchMock = makeFetch([{ ok: false, status: 401, json: async () => ({}) }]);
    const source = makeSource(fetchMock);
    expect(await source.search("folia")).toEqual([]);
  });

  it("returns [] when search fails", async () => {
    const fetchMock = makeFetch([
      { ok: true, json: async () => ({ access_token: "tok", expires_in: 3600 }) },
      { ok: false, status: 429, json: async () => ({}) },
    ]);
    const source = makeSource(fetchMock);
    expect(await source.search("folia")).toEqual([]);
  });

  it("returns [] when keyword is empty", async () => {
    const fetchMock = vi.fn() as unknown as ReturnType<typeof vi.fn> & FetchFn;
    const source = makeSource(fetchMock);
    expect(await source.search("")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] without calling fetch when credentials are missing", async () => {
    const fetchMock = vi.fn() as unknown as ReturnType<typeof vi.fn> & FetchFn;
    const source = createRedditSource({ clientId: "", clientSecret: "", fetchFn: fetchMock });
    expect(await source.search("folia")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes __clearTokenCache to force re-auth", async () => {
    const fetchMock = makeFetch([
      { ok: true, json: async () => ({ access_token: "tok-1", expires_in: 3600 }) },
      { ok: true, json: async () => ({ data: { children: [] } }) },
      { ok: true, json: async () => ({ access_token: "tok-2", expires_in: 3600 }) },
      { ok: true, json: async () => ({ data: { children: [] } }) },
    ]);
    const source = makeSource(fetchMock);
    await source.search("a");
    source.__clearTokenCache();
    await source.search("b");
    // re-auth => 4 fetches total (2 token + 2 search)
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
