// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import {
  useAnalytics,
  getAnonymousUserId,
  type AnalyticsPayload,
  type AnalyticsTransport,
} from "./useAnalytics";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function makeTransport() {
  const posted: Array<{ path: string; body: AnalyticsPayload }> = [];
  const beacons: Array<{ path: string; body: AnalyticsPayload }> = [];
  const transport: AnalyticsTransport = {
    post: vi.fn(async (path, body) => { posted.push({ path, body }); }),
    sendBeacon: vi.fn((path, body) => { beacons.push({ path, body }); }),
  };
  return { transport, posted, beacons };
}

describe("getAnonymousUserId", () => {
  it("generates a UUID once and reuses it", () => {
    const first = getAnonymousUserId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(getAnonymousUserId()).toBe(first);
    expect(localStorage.getItem("dd_anonymous_id")).toBe(first);
  });

  it("honours a custom storage key", () => {
    const id = getAnonymousUserId("my_anon");
    expect(localStorage.getItem("my_anon")).toBe(id);
    expect(localStorage.getItem("dd_anonymous_id")).toBeNull();
  });
});

describe("useAnalytics", () => {
  it("tracks a page view on mount with timestamp + anonymous user id", async () => {
    const { transport, posted } = makeTransport();
    renderHook(() => useAnalytics("dashboard", { transport }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe("/api/analytics");
    expect(posted[0]!.body).toMatchObject({ event_type: "page_view", page: "dashboard" });
    expect(posted[0]!.body.user_id).toBe(localStorage.getItem("dd_anonymous_id"));
    expect(posted[0]!.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("tracks page views only when the page actually changes", async () => {
    const { transport, posted } = makeTransport();
    const { rerender } = renderHook(
      ({ page }) => useAnalytics(page, { transport }),
      { initialProps: { page: "a" } }
    );
    rerender({ page: "a" });
    rerender({ page: "b" });

    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted.map((p) => p.body.page)).toEqual(["a", "b"]);
  });

  it("trackFeatureUse sends feature_use with merged metadata", async () => {
    const { transport, posted } = makeTransport();
    const { result } = renderHook(() => useAnalytics("crm", { transport }));

    act(() => result.current.trackFeatureUse("export", { format: "csv" }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]!.body).toMatchObject({
      event_type: "feature_use",
      page: "crm",
      metadata: { feature: "export", format: "csv" },
    });
  });

  it("flushes session_end via sendBeacon on beforeunload", () => {
    const { transport, beacons } = makeTransport();
    renderHook(() => useAnalytics("home", { transport }));

    window.dispatchEvent(new Event("beforeunload"));
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.body.event_type).toBe("session_end");
    expect(beacons[0]!.body.metadata).toHaveProperty("duration_seconds");
    expect(typeof beacons[0]!.body.metadata!.duration_seconds).toBe("number");
  });

  it("removes the beforeunload listener on unmount", () => {
    const { transport, beacons } = makeTransport();
    const { unmount } = renderHook(() => useAnalytics("home", { transport }));
    unmount();
    window.dispatchEvent(new Event("beforeunload"));
    expect(beacons).toHaveLength(0);
  });

  it("never throws when the transport rejects or throws", async () => {
    const transport: AnalyticsTransport = {
      post: vi.fn(async () => { throw new Error("network down"); }),
      sendBeacon: vi.fn(),
    };
    const { result } = renderHook(() => useAnalytics("home", { transport }));
    expect(() => act(() => result.current.trackFeatureUse("f"))).not.toThrow();
    await waitFor(() => expect(transport.post).toHaveBeenCalled());
  });

  it("supports custom endpoint and storage key", async () => {
    const { transport, posted } = makeTransport();
    renderHook(() =>
      useAnalytics("home", { transport, endpoint: "/v2/events", storageKey: "acme_anon" })
    );
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.path).toBe("/v2/events");
    expect(posted[0]!.body.user_id).toBe(localStorage.getItem("acme_anon"));
  });

  it("default transport posts JSON via fetch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useAnalytics("home"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/analytics");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.event_type).toBe("page_view");
  });
});
