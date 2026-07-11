/**
 * Tests for src/token.ts — ported from dev-dashboard-v2/tests/token.test.ts.
 *
 * Adaptation: the original mocked `server/lib/env` (SESSION_SECRET etc.).
 * Here the secret is injected via createTokenService config, and the Supabase
 * `sessions` insert is replaced by an injected SessionStore mock.
 */
import { describe, it, expect, vi } from "vitest";
import { createTokenService, timingSafeEqualStr, type SessionStore } from "./token";

const TEST_SECRET = "test-session-secret-at-least-32-characters-long";

const svc = createTokenService({ secret: TEST_SECRET });
const {
  signToken,
  verifyToken,
  decrypt,
  formatSessionCookie,
  createInviteToken,
  verifyInviteToken,
  createSessionCookie,
} = svc;

describe("timingSafeEqualStr", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualStr("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(timingSafeEqualStr("hello", "world")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(timingSafeEqualStr("short", "longer")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(timingSafeEqualStr("", "")).toBe(true);
  });
});

describe("signToken / verifyToken", () => {
  it("verifyToken returns true for a freshly signed token", () => {
    const token = signToken("auth:test@example.com:9999999999999");
    expect(verifyToken(token)).toBe(true);
  });

  it("verifyToken returns false for tampered token", () => {
    const token = signToken("auth:test@example.com:9999999999999");
    const tampered = token.slice(0, -5) + "XXXXX";
    expect(verifyToken(tampered)).toBe(false);
  });

  it("verifyToken returns false for token without dot separator", () => {
    expect(verifyToken("nodot_in_this_token")).toBe(false);
  });

  it("verifyToken returns false for empty string", () => {
    expect(verifyToken("")).toBe(false);
  });

  it("signed token has the format data.signature", () => {
    const token = signToken("session:uuid-here:123456789");
    const parts = token.split(".");
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  it("tokens are not verifiable with a different secret", () => {
    const other = createTokenService({ secret: "another-test-secret-key-not-the-same" });
    const token = signToken("auth:test@example.com:9999999999999");
    expect(other.verifyToken(token)).toBe(false);
  });
});

describe("decrypt", () => {
  it("returns null for malformed ciphertext (missing colons)", () => {
    expect(decrypt("notvalidatall")).toBeNull();
  });

  it("returns null for tampered iv:authTag:ciphertext", () => {
    const token = signToken("auth:admin:9999999999999");
    const dotIdx = token.lastIndexOf(".");
    const opaqueData = token.substring(0, dotIdx);
    // Tamper the encrypted data to trigger GCM auth failure
    const parts = opaqueData.split(":");
    parts[2] = "aabbccddeeff00112233"; // garbled ciphertext
    expect(decrypt(parts.join(":"))).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decrypt("")).toBeNull();
  });
});

describe("formatSessionCookie", () => {
  it("returns a properly formatted Set-Cookie string", () => {
    const cookie = formatSessionCookie("my-session-id");
    expect(cookie).toContain("session=my-session-id");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).toContain("Path=/");
  });

  it("respects a configured cookie name", () => {
    const custom = createTokenService({ secret: TEST_SECRET, cookieName: "my_sid" });
    expect(custom.formatSessionCookie("abc")).toContain("my_sid=abc");
  });
});

describe("createInviteToken / verifyInviteToken", () => {
  it("creates and verifies a valid invite token", () => {
    const token = createInviteToken("invite@example.com", "editor");
    const payload = verifyInviteToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.email).toBe("invite@example.com");
    expect(payload!.role).toBe("editor");
    expect(payload!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns null for tampered invite token", () => {
    const token = createInviteToken("invite@example.com", "editor");
    const tampered = token.slice(0, -4) + "ZZZZ";
    expect(verifyInviteToken(tampered)).toBeNull();
  });

  it("returns null for token without dot separator", () => {
    expect(verifyInviteToken("nodotintokenatall")).toBeNull();
  });

  it("returns null for expired invite token", async () => {
    // Create a token then fake time jump past expiry
    const token = createInviteToken("invite@example.com", "admin");
    // Decode payload and manually re-encode with old expiry to simulate expiration
    const dotIdx = token.lastIndexOf(".");
    const payload = token.substring(0, dotIdx);
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parts = decoded.split(":");
    // Replace expiresAt with a past timestamp
    parts[3] = String(Date.now() - 1000);
    const expiredPayload = Buffer.from(parts.join(":")).toString("base64url");
    // Signature won't match, so it returns null due to HMAC failure anyway
    const expiredToken = `${expiredPayload}.invalidsig1234567890123456789012`;
    expect(verifyInviteToken(expiredToken)).toBeNull();
  });

  it("returns null for empty token", () => {
    expect(verifyInviteToken("")).toBeNull();
  });
});

describe("createSessionCookie (no SessionStore)", () => {
  it("creates an email-in-token when no store is configured", async () => {
    const token = await createSessionCookie("user@example.com");
    expect(verifyToken(token)).toBe(true);
  });

  it("creates an admin token when no email is provided", async () => {
    const token = await createSessionCookie();
    expect(verifyToken(token)).toBe(true);
  });

  it("falls back to email-in-token when store is not configured (server case)", async () => {
    const token = await createSessionCookie("server@example.com");
    expect(verifyToken(token)).toBe(true);
  });
});

describe("createSessionCookie with SessionStore", () => {
  function makeStore(createResult: boolean | Error): SessionStore & { createSession: ReturnType<typeof vi.fn> } {
    return {
      createSession:
        createResult instanceof Error
          ? vi.fn().mockRejectedValue(createResult)
          : vi.fn().mockResolvedValue(createResult),
      getSession: vi.fn().mockResolvedValue(null),
    };
  }

  it("returns a UUID-based token when the store insert succeeds", async () => {
    const store = makeStore(true);
    const withStore = createTokenService({ secret: TEST_SECRET, sessionStore: store });
    const token = await withStore.createSessionCookie("db@example.com");
    expect(withStore.verifyToken(token)).toBe(true);
    expect(store.createSession).toHaveBeenCalledTimes(1);
    // Opaque data decrypts to session:{uuid}:{expires}
    const opaque = token.substring(0, token.lastIndexOf("."));
    const data = withStore.decrypt(opaque);
    expect(data).toMatch(/^session:[0-9a-f-]{36}:\d+$/);
  });

  it("falls back to email-in-token when the store insert reports failure", async () => {
    const store = makeStore(false);
    const withStore = createTokenService({ secret: TEST_SECRET, sessionStore: store });
    const token = await withStore.createSessionCookie("fallback@example.com");
    const opaque = token.substring(0, token.lastIndexOf("."));
    expect(withStore.decrypt(opaque)).toMatch(/^auth:fallback@example\.com:\d+$/);
  });

  it("falls back to email-in-token when the store insert throws", async () => {
    const store = makeStore(new Error("network down"));
    const withStore = createTokenService({ secret: TEST_SECRET, sessionStore: store });
    const token = await withStore.createSessionCookie("throw@example.com");
    const opaque = token.substring(0, token.lastIndexOf("."));
    expect(withStore.decrypt(opaque)).toMatch(/^auth:throw@example\.com:\d+$/);
  });
});

describe("config validation", () => {
  it("throws when secret is empty", () => {
    expect(() => createTokenService({ secret: "" })).toThrow();
  });
});
