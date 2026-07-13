// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import {
  useLiveState,
  type LiveStateApi,
  type LiveStateStreamHandle,
} from "./useLiveState";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SERVER_STATE = {
  tasks: { t1: { status: "done" } },
  characters: { goku: { status: "working", progress: 50, currentTask: "t1", updatedAt: "now" } },
  history: [{ time: "now", actor: "goku", action: "started", task: "t1", detail: "" }],
  sessions: [],
  updatedAt: "2026-01-01T00:00:00Z",
};

interface MockStream extends LiveStateStreamHandle {
  listeners: Map<string, Array<() => void>>;
  closed: boolean;
  fire: (event: string) => void;
}

function makeMockApi(state: Record<string, unknown> = SERVER_STATE) {
  const streams: MockStream[] = [];
  const get = vi.fn(async () => state);
  const api: LiveStateApi = {
    get,
    stream() {
      const listeners = new Map<string, Array<() => void>>();
      const stream: MockStream = {
        listeners,
        closed: false,
        addEventListener(type, listener) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        close() { stream.closed = true; },
        fire(event) { for (const l of listeners.get(event) ?? []) l(); },
      };
      streams.push(stream);
      return stream;
    },
  };
  return { api, get, streams };
}

describe("useLiveState", () => {
  it("fetches state immediately on first render (default endpoint /api/state)", async () => {
    const { api, get } = makeMockApi();
    const { result } = renderHook(() => useLiveState(60000, { api }));
    await waitFor(() => expect(result.current.updatedAt).toBe("2026-01-01T00:00:00Z"));
    expect(get).toHaveBeenCalledWith("/api/state");
    expect(result.current.tasks).toEqual(SERVER_STATE.tasks);
    expect(result.current.characters).toEqual(SERVER_STATE.characters);
    expect(result.current.history).toHaveLength(1);
  });

  it("normalises missing fields to empty structures", async () => {
    const { api, get } = makeMockApi({ updatedAt: "x" });
    const { result } = renderHook(() => useLiveState(60000, { api }));
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(result.current.updatedAt).toBe("x"));
    expect(result.current.tasks).toEqual({});
    expect(result.current.sessions).toEqual([]);
  });

  it("keeps previous state silently when fetch fails", async () => {
    const get = vi.fn(async () => { throw new Error("down"); });
    const api: LiveStateApi = {
      get,
      stream: () => ({ addEventListener: () => {}, close: () => {} }),
    };
    const { result } = renderHook(() => useLiveState(60000, { api }));
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(result.current.updatedAt).toBe("");
  });

  describe("with fake timers", () => {
    beforeEach(() => { vi.useFakeTimers(); });

    it("polls on the given interval", async () => {
      const { api, get } = makeMockApi();
      renderHook(() => useLiveState(1000, { api }));
      expect(get).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(get).toHaveBeenCalledTimes(4);
    });

    it("debounces SSE state-change events into a single refetch", async () => {
      const { api, get, streams } = makeMockApi();
      renderHook(() => useLiveState(60000, { api }));
      expect(streams).toHaveLength(1);
      expect(get).toHaveBeenCalledTimes(1);

      act(() => {
        streams[0]!.fire("state-change");
        streams[0]!.fire("state-change");
        streams[0]!.fire("state-change");
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(get).toHaveBeenCalledTimes(2); // 3 events → 1 debounced fetch
    });

    it("honours custom debounce and event name", async () => {
      const { api, get, streams } = makeMockApi();
      renderHook(() =>
        useLiveState(60000, { api, debounceMs: 1000, stateChangeEvent: "refresh" })
      );
      act(() => { streams[0]!.fire("refresh"); });
      await act(async () => { await vi.advanceTimersByTimeAsync(999); });
      expect(get).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(get).toHaveBeenCalledTimes(2);
    });

    it("keeps polling when the stream factory throws (SSE unsupported)", async () => {
      const get = vi.fn(async () => SERVER_STATE as Record<string, unknown>);
      const api: LiveStateApi = {
        get,
        stream: () => { throw new Error("EventSource is not defined"); },
      };
      renderHook(() => useLiveState(1000, { api }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(get).toHaveBeenCalledTimes(3);
    });

    it("cleans up interval, debounce timer and stream on unmount", async () => {
      const { api, get, streams } = makeMockApi();
      const { unmount } = renderHook(() => useLiveState(1000, { api }));
      act(() => { streams[0]!.fire("state-change"); });
      unmount();
      expect(streams[0]!.closed).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(get).toHaveBeenCalledTimes(1); // no polling, no debounced fetch after unmount
    });
  });

  it("stale fetch resolving last is discarded (seq guard)", async () => {
    vi.useFakeTimers();
    const resolvers: Array<(v: Record<string, unknown>) => void> = [];
    const get = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const api: LiveStateApi = {
      get,
      stream: () => ({ addEventListener: () => {}, close: () => {} }),
    };
    // 1s poll: mount issues req0, timer issues req1.
    const { result } = renderHook(() => useLiveState(1000, { api }));
    expect(get).toHaveBeenCalledTimes(1); // req0 in flight

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // req1 in flight
    expect(get).toHaveBeenCalledTimes(2);
    expect(resolvers).toHaveLength(2);

    const fresh = { updatedAt: "2026-01-02T00:00:00Z", tasks: { fresh: { status: "new" } } };
    const stale = { updatedAt: "2026-01-01T00:00:00Z", tasks: { stale: { status: "old" } } };

    // Fresher req1 resolves FIRST, stale req0 resolves LAST.
    await act(async () => {
      resolvers[1]!(fresh); // later-issued request applies
      resolvers[0]!(stale); // earlier-issued request must be discarded
    });

    expect(result.current.updatedAt).toBe("2026-01-02T00:00:00Z");
    expect(result.current.tasks).toEqual({ fresh: { status: "new" } });
  });

  it("uses custom endpoints", async () => {
    const { api, get } = makeMockApi();
    const streamSpy = vi.spyOn(api, "stream");
    renderHook(() =>
      useLiveState(60000, {
        api,
        endpoints: { state: "/v2/state", stream: "/v2/events" },
      })
    );
    await waitFor(() => expect(get).toHaveBeenCalledWith("/v2/state"));
    expect(streamSpy).toHaveBeenCalledWith("/v2/events", expect.any(Function), expect.anything());
  });
});
