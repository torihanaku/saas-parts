// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import {
  usePushSubscription,
  urlBase64ToUint8Array,
  isBrowserSupported,
  PUSH_STRINGS_JA,
} from "./usePushSubscription";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Remove the injected navigator.serviceWorker between tests
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

interface MockSubscription {
  endpoint: string;
  toJSON: () => Record<string, unknown>;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function makeSubscription(endpoint = "https://push.example/ep1"): MockSubscription {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

/** Install browser push support into jsdom. */
function installPushEnv(config: {
  permission?: NotificationPermission;
  requestPermissionResult?: NotificationPermission;
  existing?: MockSubscription | null;
} = {}) {
  const {
    permission = "default",
    requestPermissionResult = "granted",
    existing = null,
  } = config;

  const subscribe = vi.fn(async (_options?: unknown) => makeSubscription());
  const getSubscription = vi.fn(async () => existing);
  const registration = { pushManager: { subscribe, getSubscription } };

  Object.defineProperty(navigator, "serviceWorker", {
    value: { ready: Promise.resolve(registration) },
    configurable: true,
  });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", {
    permission,
    requestPermission: vi.fn(async () => requestPermissionResult),
  });

  return { subscribe, getSubscription };
}

describe("urlBase64ToUint8Array", () => {
  it("decodes URL-safe base64 into a fresh ArrayBuffer-backed view", () => {
    // "hello" → aGVsbG8 (unpadded, URL-safe)
    const out = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(out)).toEqual([104, 101, 108, 108, 111]);
    expect(out.buffer.byteLength).toBe(5);
  });

  it("handles -/_ characters", () => {
    // 0xfb 0xff → "+/8=" in standard base64 → "-_8" URL-safe
    const out = urlBase64ToUint8Array("-_8");
    expect(Array.from(out)).toEqual([251, 255]);
  });
});

describe("usePushSubscription", () => {
  it("reports unsupported in a browser without push APIs", async () => {
    expect(isBrowserSupported()).toBe(false);
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.status).toBe("unsupported"));
    expect(result.current.supported).toBe(false);

    await act(() => result.current.enable());
    expect(result.current.status).toBe("unsupported");
  });

  it("initialises to idle when supported but not subscribed", async () => {
    installPushEnv();
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.supported).toBe(true);
  });

  it("initialises to subscribed when a subscription already exists", async () => {
    installPushEnv({ existing: makeSubscription() });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.status).toBe("subscribed"));
  });

  it("initialises to denied when permission is blocked", async () => {
    installPushEnv({ permission: "denied" });
    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.status).toBe("denied"));
  });

  it("enable: permission → key fetch → subscribe → persist → subscribed", async () => {
    const { subscribe } = installPushEnv();
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/push/public-key") {
        return new Response(JSON.stringify({ publicKey: "aGVsbG8" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const { result } = renderHook(() => usePushSubscription({ fetcher }));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    await act(() => result.current.enable());
    expect(result.current.status).toBe("subscribed");
    expect(result.current.error).toBeNull();

    // subscribe called with converted VAPID key
    const arg = subscribe.mock.calls[0]![0] as unknown as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(arg.userVisibleOnly).toBe(true);
    expect(Array.from(arg.applicationServerKey)).toEqual([104, 101, 108, 108, 111]);

    // persisted with subscription JSON + user agent
    const persistCall = fetcher.mock.calls.find(([u]) => String(u) === "/api/push/subscribe")!;
    const init = persistCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.subscription.endpoint).toBe("https://push.example/ep1");
    expect(typeof body.userAgent).toBe("string");
  });

  it("enable: sets denied + default ja string when the user rejects the prompt", async () => {
    installPushEnv({ requestPermissionResult: "denied" });
    const fetcher = vi.fn();
    const { result } = renderHook(() => usePushSubscription({ fetcher }));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    await act(() => result.current.enable());
    expect(result.current.status).toBe("denied");
    expect(result.current.error).toBe(PUSH_STRINGS_JA.denied);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enable: sets error status when the public-key fetch fails", async () => {
    installPushEnv();
    const fetcher = vi.fn(async () => new Response("nope", { status: 503 }));
    const { result } = renderHook(() => usePushSubscription({ fetcher }));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    await act(() => result.current.enable());
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("public-key 503");
  });

  it("enable: supports custom strings and injected getPublicKey", async () => {
    installPushEnv({ requestPermissionResult: "denied" });
    const { result } = renderHook(() =>
      usePushSubscription({
        strings: { denied: "Blocked!" },
        getPublicKey: async () => "aGVsbG8",
      })
    );
    await waitFor(() => expect(result.current.status).toBe("idle"));
    await act(() => result.current.enable());
    expect(result.current.error).toBe("Blocked!");
  });

  it("disable: DELETEs the endpoint, unsubscribes and returns to idle", async () => {
    const existing = makeSubscription("https://push.example/ep9");
    installPushEnv({ existing });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("{}", { status: 200 }));

    const { result } = renderHook(() => usePushSubscription({ fetcher }));
    await waitFor(() => expect(result.current.status).toBe("subscribed"));

    await act(() => result.current.disable());
    expect(result.current.status).toBe("idle");
    expect(existing.unsubscribe).toHaveBeenCalled();

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/push/unsubscribe");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ endpoint: "https://push.example/ep9" });
  });

  it("disable: is a no-op server-side when nothing is subscribed", async () => {
    installPushEnv({ existing: null });
    const fetcher = vi.fn();
    const { result } = renderHook(() => usePushSubscription({ fetcher }));
    await waitFor(() => expect(result.current.status).toBe("idle"));

    await act(() => result.current.disable());
    expect(result.current.status).toBe("idle");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses custom endpoints", async () => {
    installPushEnv();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/v2/push/key") {
        return new Response(JSON.stringify({ publicKey: "aGVsbG8" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const { result } = renderHook(() =>
      usePushSubscription({
        fetcher,
        endpoints: { publicKey: "/v2/push/key", subscribe: "/v2/push/sub" },
      })
    );
    await waitFor(() => expect(result.current.status).toBe("idle"));
    await act(() => result.current.enable());
    expect(result.current.status).toBe("subscribed");
    expect(fetcher.mock.calls.map(([u]) => String(u))).toEqual(["/v2/push/key", "/v2/push/sub"]);
  });
});
