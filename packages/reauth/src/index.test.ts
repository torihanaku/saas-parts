/**
 * Ported from dev-dashboard-v2/tests/reauth-flow.test.ts, plus new coverage for
 * the injected-callback verification flow (timing-attack delay) and the
 * verify-session handler port.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReauthStore, createReauthFlow, type ReauthStore } from "./index";

describe("ReAuth Token Logic", () => {
  let store: ReauthStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createReauthStore();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it("generates a token and successfully verifies it", () => {
    const token = store.generateReauthToken("test@example.com");
    expect(token).toBeDefined();
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex

    const valid = store.verifyReauthToken(token, "test@example.com");
    expect(valid).toBe(true);
  });

  it("fails verification for wrong email", () => {
    const token = store.generateReauthToken("test@example.com");
    const valid = store.verifyReauthToken(token, "other@example.com");
    expect(valid).toBe(false);
  });

  it("fails verification after TTL expiration", () => {
    const token = store.generateReauthToken("test@example.com");

    // Advance time by 16 minutes
    vi.advanceTimersByTime(16 * 60 * 1000);

    const valid = store.verifyReauthToken(token, "test@example.com");
    expect(valid).toBe(false);
  });

  it("auto-cleans expired tokens via the interval timer", () => {
    store.generateReauthToken("a@example.com");
    store.generateReauthToken("b@example.com");
    expect(store.size()).toBe(2);

    // TTL(15min) + cleanup interval(60s) later, the sweep has removed them
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(store.size()).toBe(0);
  });

  it("respects custom ttlMs / tokenBytes", () => {
    const custom = createReauthStore({ ttlMs: 1000, tokenBytes: 16, cleanupIntervalMs: null });
    const token = custom.generateReauthToken("x@example.com");
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    vi.advanceTimersByTime(1001);
    expect(custom.verifyReauthToken(token, "x@example.com")).toBe(false);
    custom.dispose();
  });

  describe("requireReAuth middleware", () => {
    it("returns 403 if token is missing", async () => {
      const req = new Request("http://localhost", { headers: new Headers() });
      const res = await store.requireReAuth(req, "test@example.com");

      expect(res).toBeDefined();
      expect(res?.status).toBe(403);
      const data = (await res?.json()) as { error: string };
      expect(data.error).toBe("Re-authentication required");
    });

    it("returns 403 if token is invalid", async () => {
      const headers = new Headers();
      headers.set("X-Reauth-Token", "invalid-token");
      const req = new Request("http://localhost", { headers });
      const res = await store.requireReAuth(req, "test@example.com");

      expect(res).toBeDefined();
      expect(res?.status).toBe(403);
    });

    it("returns null (passes) if token is valid", async () => {
      const token = store.generateReauthToken("test@example.com");
      const headers = new Headers();
      headers.set("X-Reauth-Token", token);
      const req = new Request("http://localhost", { headers });
      const res = await store.requireReAuth(req, "test@example.com");

      expect(res).toBeNull();
    });

    it("supports a custom header name", async () => {
      const custom = createReauthStore({ headerName: "X-Step-Up", cleanupIntervalMs: null });
      const token = custom.generateReauthToken("test@example.com");
      const req = new Request("http://localhost", { headers: { "X-Step-Up": token } });
      expect(await custom.requireReAuth(req, "test@example.com")).toBeNull();
      custom.dispose();
    });
  });
});

describe("Re-verification flow (timing-attack mitigated)", () => {
  let store: ReauthStore;

  beforeEach(() => {
    store = createReauthStore({ cleanupIntervalMs: null });
  });

  afterEach(() => {
    store.dispose();
  });

  function instantSleep() {
    const calls: number[] = [];
    const sleep = (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    };
    return { calls, sleep };
  }

  it("issues a store-verifiable token when credentials verify", async () => {
    const { sleep } = instantSleep();
    const flow = createReauthFlow({
      store,
      verifyCredentials: async (email, cred) => email === "u@example.com" && cred === "correct",
      sleep,
    });
    const result = await flow.verifyAndIssueToken("u@example.com", "correct");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(store.verifyReauthToken(result.token, "u@example.com")).toBe(true);
    }
  });

  it("returns ok:false and issues no token when credentials fail", async () => {
    const { sleep } = instantSleep();
    const flow = createReauthFlow({ store, verifyCredentials: async () => false, sleep });
    const result = await flow.verifyAndIssueToken("u@example.com", "wrong");
    expect(result.ok).toBe(false);
    expect(store.size()).toBe(0);
  });

  it("applies the random delay in the 80-120ms range (source defaults)", async () => {
    const { calls, sleep } = instantSleep();
    const flow = createReauthFlow({ store, verifyCredentials: async () => true, sleep });
    for (let i = 0; i < 20; i++) {
      await flow.verifyAndIssueToken("u@example.com", "x");
    }
    expect(calls).toHaveLength(20);
    for (const ms of calls) {
      expect(ms).toBeGreaterThanOrEqual(80);
      expect(ms).toBeLessThanOrEqual(120);
    }
  });

  it("delays even on failed verification (no early return before the sleep)", async () => {
    const { calls, sleep } = instantSleep();
    const flow = createReauthFlow({ store, verifyCredentials: async () => false, sleep });
    await flow.verifyAndIssueToken("u@example.com", "wrong");
    expect(calls).toHaveLength(1);
  });

  describe("createVerifySessionHandler (route port)", () => {
    function makeFlow(verified: boolean) {
      const { sleep } = instantSleep();
      return createReauthFlow({ store, verifyCredentials: async () => verified, sleep });
    }

    const withSession = async () => "user@example.com";
    const noSession = async () => null;

    function post(body: BodyInit | undefined) {
      return new Request("http://localhost/api/auth/verify-session", { method: "POST", body });
    }

    it("401 when no session", async () => {
      const handler = makeFlow(true).createVerifySessionHandler(noSession);
      const res = await handler(post(JSON.stringify({ password: "x" })));
      expect(res.status).toBe(401);
    });

    it("400 on invalid JSON body", async () => {
      const handler = makeFlow(true).createVerifySessionHandler(withSession);
      const res = await handler(post("not-json"));
      expect(res.status).toBe(400);
    });

    it("400 when password missing", async () => {
      const handler = makeFlow(true).createVerifySessionHandler(withSession);
      const res = await handler(post(JSON.stringify({})));
      expect(res.status).toBe(400);
    });

    it("401 when credentials do not verify", async () => {
      const handler = makeFlow(false).createVerifySessionHandler(withSession);
      const res = await handler(post(JSON.stringify({ password: "wrong" })));
      expect(res.status).toBe(401);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Invalid password");
    });

    it("returns reauth_token on success, valid for the session email", async () => {
      const handler = makeFlow(true).createVerifySessionHandler(withSession);
      const res = await handler(post(JSON.stringify({ password: "correct" })));
      expect(res.status).toBe(200);
      const data = (await res.json()) as { reauth_token: string };
      expect(store.verifyReauthToken(data.reauth_token, "user@example.com")).toBe(true);
    });
  });
});
