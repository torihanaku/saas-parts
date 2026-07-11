/**
 * Ported from dev-dashboard-v2/tests/push-notifications.test.ts (lib unit tests).
 * env mutation → createPushService(config) injection. Route-handler tests were
 * not ported (the route stayed in the source app).
 */
import { describe, it, expect, vi } from "vitest";
import {
  validateSubscription,
  isKnownPushHost,
  isExpiredStatus,
  createPushService,
} from "./index";

// ─── validateSubscription ───────────────────────────────────────────────────

describe("validateSubscription", () => {
  it("rejects non-objects", () => {
    expect(validateSubscription(null).ok).toBe(false);
    expect(validateSubscription(undefined).ok).toBe(false);
    expect(validateSubscription("string").ok).toBe(false);
    expect(validateSubscription(123).ok).toBe(false);
  });

  it("rejects missing endpoint", () => {
    const r = validateSubscription({ keys: { p256dh: "a", auth: "b" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/endpoint/);
  });

  it("rejects empty endpoint", () => {
    const r = validateSubscription({ endpoint: "   ", keys: { p256dh: "a", auth: "b" } });
    expect(r.ok).toBe(false);
  });

  it("rejects malformed endpoint URL", () => {
    const r = validateSubscription({
      endpoint: "not-a-url",
      keys: { p256dh: "a", auth: "b" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/valid URL/);
  });

  it("rejects http:// endpoints", () => {
    const r = validateSubscription({
      endpoint: "http://insecure.example.com/push/abc",
      keys: { p256dh: "a", auth: "b" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https/);
  });

  it("rejects missing keys.p256dh", () => {
    const r = validateSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { auth: "b" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/p256dh/);
  });

  it("rejects missing keys.auth", () => {
    const r = validateSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "a" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/auth/);
  });

  it("rejects when keys is not an object", () => {
    const r = validateSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: "string",
    });
    expect(r.ok).toBe(false);
  });

  it("trims and accepts a well-formed subscription", () => {
    const r = validateSubscription({
      endpoint: "  https://fcm.googleapis.com/fcm/send/abc  ",
      keys: { p256dh: " keyA ", auth: " keyB " },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.subscription.endpoint).toBe("https://fcm.googleapis.com/fcm/send/abc");
      expect(r.subscription.p256dh).toBe("keyA");
      expect(r.subscription.auth).toBe("keyB");
    }
  });
});

// ─── isKnownPushHost / isExpiredStatus ──────────────────────────────────────

describe("isKnownPushHost", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-bn3p.notify.windows.com/abc",
    "https://web.push.apple.com/abc",
  ])("recognises %s", (url) => {
    expect(isKnownPushHost(url)).toBe(true);
  });

  it("returns false for unknown hosts", () => {
    expect(isKnownPushHost("https://example.com/push/abc")).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(isKnownPushHost("not-a-url")).toBe(false);
  });
});

describe("isExpiredStatus", () => {
  it("classifies 404 / 410 as expired", () => {
    expect(isExpiredStatus(404)).toBe(true);
    expect(isExpiredStatus(410)).toBe(true);
  });

  it("does not classify 5xx as expired", () => {
    expect(isExpiredStatus(500)).toBe(false);
    expect(isExpiredStatus(503)).toBe(false);
  });

  it("does not classify 200 as expired", () => {
    expect(isExpiredStatus(200)).toBe(false);
  });
});

// ─── VAPID config resolution ────────────────────────────────────────────────

describe("VAPID config", () => {
  it("getVapidConfig returns null when keys missing", () => {
    const svc = createPushService({});
    expect(svc.getVapidConfig()).toBeNull();
    expect(svc.getPublicVapidKey()).toBeNull();
  });

  it("returns null when only one key is present", () => {
    expect(createPushService({ vapidPublicKey: "pub" }).getVapidConfig()).toBeNull();
    expect(createPushService({ vapidPrivateKey: "priv" }).getVapidConfig()).toBeNull();
  });

  it("wraps non-mailto/https subject in mailto:", () => {
    const svc = createPushService({
      vapidPublicKey: "pub",
      vapidPrivateKey: "priv",
      vapidSubject: "ops@folia.example",
    });
    const cfg = svc.getVapidConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.subject).toBe("mailto:ops@folia.example");
  });

  it("accepts explicit mailto: subject", () => {
    const svc = createPushService({
      vapidPublicKey: "pub",
      vapidPrivateKey: "priv",
      vapidSubject: "mailto:already@example.com",
    });
    expect(svc.getVapidConfig()!.subject).toBe("mailto:already@example.com");
  });

  it("accepts explicit https:// subject", () => {
    const svc = createPushService({
      vapidPublicKey: "pub",
      vapidPrivateKey: "priv",
      vapidSubject: "https://folia.example/contact",
    });
    expect(svc.getVapidConfig()!.subject).toBe("https://folia.example/contact");
  });

  it("falls back to appUrl when subject missing", () => {
    const svc = createPushService({
      vapidPublicKey: "pub",
      vapidPrivateKey: "priv",
      appUrl: "https://folia.example",
    });
    expect(svc.getVapidConfig()!.subject).toBe("https://folia.example");
  });

  it("falls back to placeholder when no subject and no appUrl", () => {
    const svc = createPushService({ vapidPublicKey: "pub", vapidPrivateKey: "priv" });
    expect(svc.getVapidConfig()!.subject).toContain("mailto:");
  });

  it("getPublicVapidKey returns the key when present", () => {
    const svc = createPushService({ vapidPublicKey: "the-key", vapidPrivateKey: "priv" });
    expect(svc.getPublicVapidKey()).toBe("the-key");
  });
});

// ─── sendNotification ───────────────────────────────────────────────────────

describe("sendNotification", () => {
  const SUB = { endpoint: "https://fcm.googleapis.com/x", p256dh: "a", auth: "b" };
  const PAYLOAD = { title: "t", body: "b" };

  it("returns vapid_not_configured when keys missing", async () => {
    const svc = createPushService({});
    const res = await svc.sendNotification(SUB, PAYLOAD);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("vapid_not_configured");
  });

  it("returns sender_not_bound when no sender injected", async () => {
    const svc = createPushService({ vapidPublicKey: "pub", vapidPrivateKey: "priv" });
    const res = await svc.sendNotification(SUB, PAYLOAD);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("sender_not_bound");
  });

  it("delegates to the bound sender on success", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true });
    const svc = createPushService({ vapidPublicKey: "pub", vapidPrivateKey: "priv" });
    svc.setSender(sender);
    const res = await svc.sendNotification(SUB, PAYLOAD);
    expect(res.ok).toBe(true);
    expect(sender).toHaveBeenCalledTimes(1);
    const [sub, payload, vapid] = sender.mock.calls[0]!;
    expect(sub.endpoint).toContain("fcm.googleapis.com");
    expect(payload.title).toBe("t");
    expect(vapid.publicKey).toBe("pub");
  });

  it("accepts a sender via config and can unbind it", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true });
    const svc = createPushService({ vapidPublicKey: "pub", vapidPrivateKey: "priv", sender });
    expect((await svc.sendNotification(SUB, PAYLOAD)).ok).toBe(true);
    svc.setSender(null);
    expect((await svc.sendNotification(SUB, PAYLOAD)).error).toBe("sender_not_bound");
  });

  it("captures sender exceptions and returns ok:false", async () => {
    const svc = createPushService({ vapidPublicKey: "pub", vapidPrivateKey: "priv" });
    svc.setSender(() => {
      throw new Error("boom");
    });
    const res = await svc.sendNotification(SUB, PAYLOAD);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
  });

  it("converts non-Error throws into string error messages", async () => {
    const svc = createPushService({ vapidPublicKey: "pub", vapidPrivateKey: "priv" });
    svc.setSender(() => {
      // eslint-disable-next-line no-throw-literal
      throw "stringy-failure";
    });
    const res = await svc.sendNotification(SUB, PAYLOAD);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("stringy-failure");
  });
});
