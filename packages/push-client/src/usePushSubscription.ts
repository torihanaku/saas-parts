/**
 * PWA Push Notifications — browser-side subscribe lifecycle.
 *
 * Wraps:
 *   1. Notification permission prompt
 *   2. ServiceWorker registration lookup
 *   3. PushManager.subscribe(applicationServerKey)
 *   4. POST {subscribe} (persist the subscription server-side)
 *   5. unsubscribe + DELETE {unsubscribe} (mirror)
 *
 * Components consume `{ supported, status, error, enable, disable }`.
 * Status values are stable so a notification button can drive UI state machines.
 *
 * Ported from 実運用SaaS `src/hooks/usePushSubscription.ts` (155 LOC).
 * Differences from the original:
 *   - react-i18next `useTranslation` → injectable strings (defaults = original
 *     ja locale values; en set also exported)
 *   - hard-coded `/api/push/*` endpoints & VAPID key fetch → config
 *     (fetcher / getPublicKey injectable)
 *
 * Server-side counterpart: pairs with `@torihanaku/push-notifications`
 * (VAPID config + delivery), without importing it.
 */
import { useCallback, useEffect, useState } from "react";

export type PushStatus =
  | "loading"
  | "unsupported"
  | "denied"
  | "idle"
  | "subscribing"
  | "subscribed"
  | "unsubscribing"
  | "error";

export interface UsePushSubscriptionResult {
  supported: boolean;
  status: PushStatus;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

/** User-facing strings consumed by the hook. */
export interface PushStrings {
  /** Shown when the user blocks the permission prompt. */
  denied: string;
  /** Fallback for errors without a message. */
  errorGeneric: string;
}

/** Original ja locale values (`push.*` in 実運用SaaS `src/locales/ja.json`). */
export const PUSH_STRINGS_JA: PushStrings = {
  denied: "プッシュ通知の許可がブロックされています",
  errorGeneric: "プッシュ通知の操作に失敗しました",
};

/** Original en locale values (`push.*` in 実運用SaaS `src/locales/en.json`). */
export const PUSH_STRINGS_EN: PushStrings = {
  denied: "Push notification permission is blocked",
  errorGeneric: "Push notification action failed",
};

export interface PushEndpoints {
  /** GET → `{ publicKey: string }` (VAPID public key). Default: "/api/push/public-key". */
  publicKey: string;
  /** POST `{ subscription, userAgent }`. Default: "/api/push/subscribe". */
  subscribe: string;
  /** DELETE `{ endpoint }`. Default: "/api/push/unsubscribe". */
  unsubscribe: string;
}

export interface UsePushSubscriptionOptions {
  /** Endpoint overrides. */
  endpoints?: Partial<PushEndpoints>;
  /** Fetch implementation (auth header injection etc.). Default: `globalThis.fetch`. */
  fetcher?: typeof fetch;
  /**
   * VAPID public key resolver. Default: GET `endpoints.publicKey` via
   * `fetcher` and read `publicKey` from the JSON body.
   */
  getPublicKey?: () => Promise<string>;
  /** UI strings. Default: {@link PUSH_STRINGS_JA} (original locale values). */
  strings?: Partial<PushStrings>;
}

// Returns a Uint8Array backed by a fresh ArrayBuffer so it satisfies
// PushSubscriptionOptionsInit.applicationServerKey (BufferSource — disallows
// SharedArrayBuffer-backed views).
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalised);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

export function isBrowserSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

interface ResolvedOptions {
  endpoints: PushEndpoints;
  fetcher: typeof fetch;
  getPublicKey: () => Promise<string>;
  strings: PushStrings;
}

function resolveOptions(options: UsePushSubscriptionOptions): ResolvedOptions {
  const endpoints: PushEndpoints = {
    publicKey: options.endpoints?.publicKey ?? "/api/push/public-key",
    subscribe: options.endpoints?.subscribe ?? "/api/push/subscribe",
    unsubscribe: options.endpoints?.unsubscribe ?? "/api/push/unsubscribe",
  };
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const getPublicKey = options.getPublicKey ?? (async () => {
    const keyRes = await fetcher(endpoints.publicKey);
    if (!keyRes.ok) throw new Error(`public-key ${keyRes.status}`);
    const { publicKey } = (await keyRes.json()) as { publicKey: string };
    return publicKey;
  });
  return {
    endpoints,
    fetcher,
    getPublicKey,
    strings: { ...PUSH_STRINGS_JA, ...options.strings },
  };
}

export function usePushSubscription(
  options: UsePushSubscriptionOptions = {}
): UsePushSubscriptionResult {
  // Resolved once on first use per render; cheap and dependency-stable via
  // the individual fields captured below.
  const [resolved] = useState<ResolvedOptions>(() => resolveOptions(options));
  const [status, setStatus] = useState<PushStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const supported = isBrowserSupported();

  const refresh = useCallback(async (): Promise<void> => {
    if (!supported) {
      setStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      setStatus(existing ? "subscribed" : "idle");
    } catch (_e) {
      setStatus("idle");
    }
  }, [supported]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enable = useCallback(async (): Promise<void> => {
    if (!supported) {
      setStatus("unsupported");
      return;
    }
    setError(null);
    setStatus("subscribing");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("denied");
        setError(resolved.strings.denied);
        return;
      }
      const publicKey = await resolved.getPublicKey();

      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      const persistRes = await resolved.fetcher(resolved.endpoints.subscribe, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          userAgent: navigator.userAgent,
        }),
      });
      if (!persistRes.ok) throw new Error(`subscribe ${persistRes.status}`);
      setStatus("subscribed");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg || resolved.strings.errorGeneric);
      setStatus("error");
    }
  }, [supported, resolved]);

  const disable = useCallback(async (): Promise<void> => {
    if (!supported) {
      setStatus("unsupported");
      return;
    }
    setError(null);
    setStatus("unsubscribing");
    try {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (subscription) {
        await resolved.fetcher(resolved.endpoints.unsubscribe, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      setStatus("idle");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg || resolved.strings.errorGeneric);
      setStatus("error");
    }
  }, [supported, resolved]);

  return { supported, status, error, enable, disable };
}
