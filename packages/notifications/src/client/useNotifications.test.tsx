// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { useNotifications, type Notification } from "./useNotifications";
import type { NotificationsClientApi } from "./api";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n1",
    type: "ci-failure",
    title: "CI failed",
    message: "build broke",
    read: false,
    user_id: "u1",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

interface MockStream {
  path: string;
  emit: (data: unknown) => void;
  fireError: () => void;
  close: ReturnType<typeof vi.fn<() => void>>;
}

function makeMockApi(history: unknown = []) {
  const streams: MockStream[] = [];
  const get = vi.fn(async () => history);
  const post = vi.fn(async () => ({ ok: true }));
  const api: NotificationsClientApi = {
    get,
    post,
    stream(path, onMessage, options) {
      const stream: MockStream = {
        path,
        emit: onMessage,
        fireError: () => options?.onError?.(new Event("error")),
        close: vi.fn<() => void>(),
      };
      streams.push(stream);
      return stream;
    },
  };
  return { api, get, post, streams };
}

describe("useNotifications", () => {
  it("fetches history and exposes unreadCount", async () => {
    const { api, get } = makeMockApi([
      makeNotification({ id: "a", read: false }),
      makeNotification({ id: "b", read: true }),
    ]);
    const { result } = renderHook(() => useNotifications({ api }));

    await waitFor(() => expect(result.current.notifications).toHaveLength(2));
    expect(get).toHaveBeenCalledWith("/api/notifications");
    expect(result.current.unreadCount).toBe(1);
  });

  it("unwraps { items } shaped history responses", async () => {
    const { api } = makeMockApi({ items: [makeNotification({ id: "a" })] });
    const { result } = renderHook(() => useNotifications({ api }));
    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
  });

  it("prepends SSE notifications and dedupes by id", async () => {
    const { api, streams } = makeMockApi([makeNotification({ id: "a" })]);
    const { result } = renderHook(() => useNotifications({ api }));
    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    expect(streams[0]!.path).toBe("/api/notifications/stream");

    act(() => streams[0]!.emit(makeNotification({ id: "b", title: "new" })));
    expect(result.current.notifications.map((n) => n.id)).toEqual(["b", "a"]);

    act(() => streams[0]!.emit(makeNotification({ id: "b" })));
    expect(result.current.notifications).toHaveLength(2);
  });

  it("drops SSE notifications whose type is disabled in preferences", async () => {
    localStorage.setItem(
      "techradar-notification-prefs",
      JSON.stringify({ enabled: true, types: { "cost-alert": false } })
    );
    const { api, streams } = makeMockApi();
    const { result } = renderHook(() => useNotifications({ api }));
    await waitFor(() => expect(streams).toHaveLength(1));

    act(() => streams[0]!.emit(makeNotification({ id: "x", type: "cost-alert" })));
    expect(result.current.notifications).toHaveLength(0);

    act(() => streams[0]!.emit(makeNotification({ id: "y", type: "ci-failure" })));
    expect(result.current.notifications).toHaveLength(1);
  });

  it("does not open the SSE stream when preferences are disabled", async () => {
    localStorage.setItem(
      "techradar-notification-prefs",
      JSON.stringify({ enabled: false, types: {} })
    );
    const { api, get, streams } = makeMockApi();
    renderHook(() => useNotifications({ api }));
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(streams).toHaveLength(0);
  });

  it("markAsRead updates state optimistically and hits the markRead endpoint", async () => {
    const { api, post } = makeMockApi([makeNotification({ id: "a" })]);
    const { result } = renderHook(() => useNotifications({ api }));
    await waitFor(() => expect(result.current.notifications).toHaveLength(1));

    await act(() => result.current.markAsRead("a"));
    expect(result.current.notifications[0]!.read).toBe(true);
    expect(result.current.unreadCount).toBe(0);
    expect(post).toHaveBeenCalledWith("/api/notifications/a/read");
  });

  it("markAllAsRead marks every unread notification", async () => {
    const { api, post } = makeMockApi([
      makeNotification({ id: "a" }),
      makeNotification({ id: "b" }),
      makeNotification({ id: "c", read: true }),
    ]);
    const { result } = renderHook(() => useNotifications({ api }));
    await waitFor(() => expect(result.current.notifications).toHaveLength(3));

    await act(() => result.current.markAllAsRead());
    expect(result.current.unreadCount).toBe(0);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("reconnects the SSE stream after an error", async () => {
    const { api, streams } = makeMockApi();
    const { unmount } = renderHook(() =>
      useNotifications({ api, reconnectDelayMs: 5 })
    );
    await waitFor(() => expect(streams).toHaveLength(1));

    act(() => streams[0]!.fireError());
    expect(streams[0]!.close).toHaveBeenCalled();
    await waitFor(() => expect(streams).toHaveLength(2));

    unmount();
    expect(streams[1]!.close).toHaveBeenCalled();
  });

  it("caps the in-memory list at maxItems", async () => {
    const { api, streams } = makeMockApi();
    const { result } = renderHook(() => useNotifications({ api, maxItems: 2 }));
    await waitFor(() => expect(streams).toHaveLength(1));

    act(() => {
      streams[0]!.emit(makeNotification({ id: "1" }));
      streams[0]!.emit(makeNotification({ id: "2" }));
      streams[0]!.emit(makeNotification({ id: "3" }));
    });
    expect(result.current.notifications.map((n) => n.id)).toEqual(["3", "2"]);
  });
});
