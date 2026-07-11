// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { useCommands, type Command, type CommandsApi } from "./useCommands";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HISTORY: Command[] = [
  {
    id: "c1",
    text: "デザインを直して",
    assignee: "18号（デザイン担当）",
    repo: "techradar-ai",
    labels: ["design"],
    timestamp: "2026-01-01T00:00:00Z",
  },
];

function makeMockApi(initial: Command[] = HISTORY) {
  let history = initial;
  const get = vi.fn(async () => history);
  const post = vi.fn(async (_path: string, body: unknown) => {
    const { text } = body as { text: string };
    history = [
      { id: `c${history.length + 1}`, text, assignee: "x", repo: "r", labels: [], timestamp: "now" },
      ...history,
    ];
    return { ok: true };
  });
  const api: CommandsApi = { get, post };
  return { api, get, post };
}

describe("useCommands", () => {
  it("fetches command history on mount (default endpoint /api/commands)", async () => {
    const { api, get } = makeMockApi();
    const { result } = renderHook(() => useCommands({ api }));
    await waitFor(() => expect(result.current.commands).toHaveLength(1));
    expect(get).toHaveBeenCalledWith("/api/commands");
  });

  it("sendCommand posts { text } and refetches history", async () => {
    const { api, post } = makeMockApi();
    const { result } = renderHook(() => useCommands({ api }));
    await waitFor(() => expect(result.current.commands).toHaveLength(1));

    let ok = false;
    await act(async () => { ok = await result.current.sendCommand("バグを直して"); });
    expect(ok).toBe(true);
    expect(post).toHaveBeenCalledWith("/api/command", { text: "バグを直して" });
    await waitFor(() => expect(result.current.commands).toHaveLength(2));
    expect(result.current.loading).toBe(false);
  });

  it("sendCommand returns false on failure and clears loading", async () => {
    const api: CommandsApi = {
      get: vi.fn(async () => []),
      post: vi.fn(async () => { throw new Error("boom"); }),
    };
    const { result } = renderHook(() => useCommands({ api }));

    let ok = true;
    await act(async () => { ok = await result.current.sendCommand("x"); });
    expect(ok).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("fails silently when history fetch throws", async () => {
    const api: CommandsApi = {
      get: vi.fn(async () => { throw new Error("boom"); }),
      post: vi.fn(async () => ({})),
    };
    const { result } = renderHook(() => useCommands({ api }));
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(result.current.commands).toEqual([]);
  });

  it("supports custom endpoints and { items } shaped responses", async () => {
    const get = vi.fn(async () => ({ items: HISTORY }));
    const post = vi.fn(async () => ({}));
    const { result } = renderHook(() =>
      useCommands({
        api: { get, post },
        endpoints: { list: "/v2/history", send: "/v2/intake" },
      })
    );
    await waitFor(() => expect(result.current.commands).toHaveLength(1));
    expect(get).toHaveBeenCalledWith("/v2/history");

    await act(async () => { await result.current.sendCommand("hey"); });
    expect(post).toHaveBeenCalledWith("/v2/intake", { text: "hey" });
  });

  it("default api uses fetch against the original endpoints", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/commands") {
        return new Response(JSON.stringify(HISTORY), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCommands());
    await waitFor(() => expect(result.current.commands).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/commands");
  });
});
