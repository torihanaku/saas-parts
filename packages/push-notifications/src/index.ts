/**
 * @torihanaku/push-notifications — Web Push protocol wrapper (Foundation).
 *
 * 出典: 実運用SaaS/server/lib/push-notifications.ts（忠実移植）。
 * 変更点: process.env 直読み → createPushService(config) による設定注入、
 * __setSenderForTests → setSender（正式な注入ポイントに昇格）。
 *
 * Foundation responsibilities (covered here):
 *   - Validate / normalise PushSubscription payloads from the browser
 *   - Surface VAPID configuration health in a single place
 *   - Provide a `sendNotification` shim that's safe to call but defers to
 *     the bound sender (e.g. `web-push`) only when VAPID keys are set
 *
 * This layer is intentionally I/O free — the real delivery library
 * (`web-push` etc.) is injected via `setSender`, so this package has no
 * runtime dependency on it.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Minimal serialisation of a browser-side `PushSubscription`. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface NormalisedSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  icon?: string;
  tag?: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface SendResult {
  ok: boolean;
  /** Set when the underlying push service returned a fatal status (404 / 410). */
  expired?: boolean;
  /** Free-form diagnostic; never expose to end users without sanitising. */
  error?: string;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const ENDPOINT_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "wns2-",
  "notify.windows.com",
  "push.apple.com",
  "web.push.apple.com",
];

/**
 * Validate a subscription payload from the browser.
 *
 * Checks endpoint URL shape + key presence. Does NOT perform crypto verification —
 * that happens implicitly when the push service rejects the subscription at
 * delivery time.
 */
export function validateSubscription(
  raw: unknown,
): { ok: true; subscription: NormalisedSubscription } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "subscription must be an object" };
  }
  const obj = raw as Record<string, unknown>;
  const endpoint = typeof obj.endpoint === "string" ? obj.endpoint.trim() : "";
  if (!endpoint) {
    return { ok: false, error: "endpoint is required" };
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, error: "endpoint is not a valid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "endpoint must use https://" };
  }

  const keysObj = obj.keys && typeof obj.keys === "object" ? (obj.keys as Record<string, unknown>) : null;
  const p256dh = keysObj && typeof keysObj.p256dh === "string" ? keysObj.p256dh.trim() : "";
  const auth = keysObj && typeof keysObj.auth === "string" ? keysObj.auth.trim() : "";
  if (!p256dh) return { ok: false, error: "keys.p256dh is required" };
  if (!auth) return { ok: false, error: "keys.auth is required" };

  return {
    ok: true,
    subscription: { endpoint, p256dh, auth },
  };
}

/**
 * Best-effort check that the endpoint host belongs to a known push service.
 * Used for diagnostics — we never block based on this since new services emerge.
 */
export function isKnownPushHost(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).host;
    return ENDPOINT_HOSTS.some((known) => host.includes(known));
  } catch {
    return false;
  }
}

/**
 * Classify a push service error status as "expired" (subscription should be
 * removed) vs "transient". Centralised so the delivery cron and tests share
 * the same definition.
 */
export function isExpiredStatus(status: number): boolean {
  return status === 404 || status === 410;
}

// ─── Service (config-injected) ──────────────────────────────────────────────

/**
 * Lightweight injection point so callers can plug in the real `web-push`
 * library (or any transport) without this package depending on it at runtime.
 */
export type PushSender = (
  subscription: NormalisedSubscription,
  payload: PushPayload,
  vapid: VapidConfig,
) => Promise<SendResult>;

export interface PushServiceConfig {
  /** VAPID public key（元実装: VAPID_PUBLIC_KEY）。 */
  vapidPublicKey?: string;
  /** VAPID private key（元実装: VAPID_PRIVATE_KEY）。 */
  vapidPrivateKey?: string;
  /** VAPID subject（元実装: VAPID_SUBJECT）。mailto:/https:// 以外は mailto: が前置される。 */
  vapidSubject?: string;
  /** subject 未指定時のフォールバック（元実装: APP_URL）。 */
  appUrl?: string;
  /** 配送実装（web-push 等）。後から setSender でも注入可。 */
  sender?: PushSender;
}

export interface PushService {
  /** Resolve VAPID configuration. Returns null when keys are missing. */
  getVapidConfig: () => VapidConfig | null;
  /** Public-facing config consumed by the browser to subscribe. */
  getPublicVapidKey: () => string | null;
  /** Send one push payload to one subscription. Never throws. */
  sendNotification: (
    subscription: NormalisedSubscription,
    payload: PushPayload,
  ) => Promise<SendResult>;
  /** Bind / unbind the delivery implementation. */
  setSender: (sender: PushSender | null) => void;
}

export function createPushService(config: PushServiceConfig = {}): PushService {
  let senderBinding: PushSender | null = config.sender ?? null;

  function resolveSubject(): string {
    const explicit = config.vapidSubject?.trim();
    if (explicit) {
      if (explicit.startsWith("mailto:") || explicit.startsWith("https://")) return explicit;
      return `mailto:${explicit}`;
    }
    const appUrl = config.appUrl?.trim();
    if (appUrl) return appUrl;
    // RFC 8292 requires either mailto: or https:// — fall back to a marker
    // that's obviously a placeholder so misconfiguration is visible in logs.
    return "mailto:noreply@example.invalid";
  }

  /**
   * Resolve VAPID configuration. Returns null when keys are missing —
   * Foundation deployments may run without keys; only the delivery cron
   * requires a fully populated config.
   */
  function getVapidConfig(): VapidConfig | null {
    const publicKey = config.vapidPublicKey;
    const privateKey = config.vapidPrivateKey;
    if (!publicKey || !privateKey) return null;

    const subject = resolveSubject();
    return { publicKey, privateKey, subject };
  }

  function getPublicVapidKey(): string | null {
    return config.vapidPublicKey ?? null;
  }

  /**
   * Send one push payload to one subscription:
   *   - returns `{ ok: false, error: "vapid_not_configured" }` when keys are absent
   *   - delegates to the injected sender when present
   *   - never throws — callers receive `SendResult` for retry / cleanup decisions
   */
  async function sendNotification(
    subscription: NormalisedSubscription,
    payload: PushPayload,
  ): Promise<SendResult> {
    const vapid = getVapidConfig();
    if (!vapid) {
      return { ok: false, error: "vapid_not_configured" };
    }
    const sender = senderBinding;
    if (!sender) {
      return { ok: false, error: "sender_not_bound" };
    }
    try {
      return await sender(subscription, payload, vapid);
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      return { ok: false, error: err };
    }
  }

  function setSender(sender: PushSender | null): void {
    senderBinding = sender;
  }

  return { getVapidConfig, getPublicVapidKey, sendNotification, setSender };
}
