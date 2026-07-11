/**
 * Tests for src/auth.ts — ported from dev-dashboard-v2/tests/server-auth.test.ts.
 *
 * Adaptations from the original:
 * - process.env.SESSION_SECRET → injected via createAuthService({ secret })
 * - globalThis.fetch mocks of the Supabase /auth/v1/user endpoint → injected
 *   BearerResolver mocks
 * - globalThis.fetch mocks of dashboard_team_members lookups → injected
 *   RoleResolver mocks
 * - ADMIN_EMAIL env (read at module init in the original, which made two tests
 *   non-deterministic) → injected adminEmail config; those tests are now exact.
 *
 * All secrets/keys below are fake fixtures for testing only.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createAuthService, getSecureOrigin, type AuthConfig } from "./auth";

const TEST_SECRET = "test-secret-key-for-testing-only";

function makeAuth(overrides: Partial<AuthConfig> = {}) {
  return createAuthService({ secret: TEST_SECRET, ...overrides });
}

// Default service (no store, no resolvers) — mirrors the original test env where
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY were unset (email-in-token fallback mode).
const auth = makeAuth();

describe("Auth Token Security", () => {
  it("signToken produces data.signature format", () => {
    const token = auth.signToken("auth:1234567890");
    expect(token).toContain(".");
    const parts = token.split(".");
    // Data part should be opaque (encrypted format iv:authTag:ciphertext)
    expect(parts[0]).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    // Signature should be 32 hex chars
    expect(parts[parts.length - 1]).toHaveLength(32);
    expect(parts[parts.length - 1]).toMatch(/^[a-f0-9]+$/);
  });

  it("verifyToken accepts valid tokens", () => {
    const token = auth.signToken("auth:9999999999999");
    expect(auth.verifyToken(token)).toBe(true);
  });

  it("verifyToken rejects tampered data", () => {
    const token = auth.signToken("auth:1234567890");
    const parts = token.split(".");
    // Flip a character in the opaque data
    const data = parts[0]!;
    const tamperedData = (data[0] === "a" ? "b" : "a") + data.substring(1);
    const tampered = tamperedData + "." + parts[1];
    expect(auth.verifyToken(tampered)).toBe(false);
  });

  it("verifyToken rejects tampered signature", () => {
    const token = auth.signToken("auth:1234567890");
    const dotIdx = token.lastIndexOf(".");
    const tamperedSig = token.substring(0, dotIdx + 1) + "a".repeat(32);
    expect(auth.verifyToken(tamperedSig)).toBe(false);
  });

  it("verifyToken rejects truncated 16-char signatures (no backward compat)", () => {
    const token = auth.signToken("auth:1234567890");
    const dotIdx = token.lastIndexOf(".");
    const data = token.substring(0, dotIdx);
    const sig = token.substring(dotIdx + 1);
    // Take only first 16 chars of signature (old backward compat)
    const shortToken = data + "." + sig.substring(0, 16);
    expect(auth.verifyToken(shortToken)).toBe(false);
  });

  it("verifyToken rejects empty token", () => {
    expect(auth.verifyToken("")).toBe(false);
  });

  it("verifyToken rejects token without dot", () => {
    expect(auth.verifyToken("nodothere")).toBe(false);
  });

  it("createSessionCookie produces valid token (no-store fallback = email-in-token)", async () => {
    const cookie = await auth.createSessionCookie("test@example.com");
    expect(auth.verifyToken(cookie)).toBe(true);

    // Verify we can still extract the email (round-trip check)
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });
    expect(await auth.getSessionEmail(req)).toBe("test@example.com");
  });

  it("checkAuth rejects request without session cookie", async () => {
    const req = new Request("http://localhost/api/test");
    expect(await auth.checkAuth(req)).toBe(false);
  });

  it("checkAuth rejects expired session", async () => {
    // Create token that expired 1 hour ago
    const expired = auth.signToken(`auth:${Date.now() - 3600000}`);
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${expired}` },
    });
    expect(await auth.checkAuth(req)).toBe(false);
  });

  it("checkAuth accepts valid session", async () => {
    const cookie = await auth.createSessionCookie();
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });
    expect(await auth.checkAuth(req)).toBe(true);
  });

  it("getSessionEmail extracts email from legacy email-in-token format", async () => {
    const cookie = await auth.createSessionCookie("user@example.com");
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });
    expect(await auth.getSessionEmail(req)).toBe("user@example.com");
  });

  it("getSessionEmail returns null for old format token (no email)", async () => {
    // Old format: auth:{expires} without email
    const oldToken = auth.signToken(`auth:${Date.now() + 86400000}`);
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${oldToken}` },
    });
    expect(await auth.getSessionEmail(req)).toBeNull();
  });

  it("getSessionEmail returns null for expired token", async () => {
    const expired = auth.signToken(`auth:user@test.com:${Date.now() - 3600000}`);
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${expired}` },
    });
    expect(await auth.getSessionEmail(req)).toBeNull();
  });

  it("getSessionEmail returns null for unauthenticated request", async () => {
    const req = new Request("http://localhost/api/test");
    expect(await auth.getSessionEmail(req)).toBeNull();
  });

  it('createSessionCookie defaults to "admin" when no email provided (no-store fallback)', async () => {
    const cookie = await auth.createSessionCookie();
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });
    expect(await auth.getSessionEmail(req)).toBe("admin");
  });

  it("UUID-based token (session: prefix) returns null when no SessionStore configured", async () => {
    // Simulate a UUID-based token without a session store configured
    const fakeUuid = "550e8400-e29b-41d4-a716-446655440000";
    const expires = Date.now() + 86400000;
    const uuidToken = auth.signToken(`session:${fakeUuid}:${expires}`);
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${uuidToken}` },
    });
    // No SessionStore in this service → returns null
    expect(await auth.getSessionEmail(req)).toBeNull();
  });

  it("checkAuth accepts valid session (duplicate coverage)", async () => {
    const cookie = await auth.createSessionCookie();
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });
    expect(await auth.checkAuth(req)).toBe(true);
  });
});

describe("Session store lookup (UUID tokens)", () => {
  it("getSessionEmail resolves email through the SessionStore", async () => {
    const fakeUuid = "550e8400-e29b-41d4-a716-446655440000";
    const getSession = vi.fn().mockResolvedValue({
      email: "stored@example.com",
      expiresAt: new Date(Date.now() + 86400000),
    });
    const withStore = makeAuth({
      sessionStore: { createSession: vi.fn().mockResolvedValue(true), getSession },
    });
    const expires = Date.now() + 86400000;
    const uuidToken = withStore.signToken(`session:${fakeUuid}:${expires}`);
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${uuidToken}` },
    });
    expect(await withStore.getSessionEmail(req)).toBe("stored@example.com");
    expect(getSession).toHaveBeenCalledWith(fakeUuid);
  });

  it("getSessionEmail returns null when the stored session row is expired", async () => {
    const fakeUuid = "550e8400-e29b-41d4-a716-446655440000";
    const withStore = makeAuth({
      sessionStore: {
        createSession: vi.fn().mockResolvedValue(true),
        getSession: vi.fn().mockResolvedValue({
          email: "stale@example.com",
          expiresAt: new Date(Date.now() - 1000),
        }),
      },
    });
    const expires = Date.now() + 86400000;
    const uuidToken = withStore.signToken(`session:${fakeUuid}:${expires}`);
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${uuidToken}` },
    });
    expect(await withStore.getSessionEmail(req)).toBeNull();
  });
});

describe("Invite Token", () => {
  it("createInviteToken produces a dot-separated token", () => {
    const token = auth.createInviteToken("invite@example.com", "editor");
    expect(token).toContain(".");
  });

  it("verifyInviteToken round-trips email and role", () => {
    const token = auth.createInviteToken("member@example.com", "viewer");
    const payload = auth.verifyInviteToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.email).toBe("member@example.com");
    expect(payload!.role).toBe("viewer");
    expect(payload!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("verifyInviteToken rejects tampered payload", () => {
    const token = auth.createInviteToken("tamper@example.com", "admin");
    const dotIdx = token.lastIndexOf(".");
    // Flip a character in the base64 payload
    const payload = token.substring(0, dotIdx);
    const sig = token.substring(dotIdx + 1);
    const tampered = (payload[0] === "A" ? "B" : "A") + payload.substring(1) + "." + sig;
    expect(auth.verifyInviteToken(tampered)).toBeNull();
  });

  it("verifyInviteToken rejects token with wrong signature", () => {
    const token = auth.createInviteToken("wrong@example.com", "viewer");
    const dotIdx = token.lastIndexOf(".");
    const fakeToken = token.substring(0, dotIdx + 1) + "a".repeat(32);
    expect(auth.verifyInviteToken(fakeToken)).toBeNull();
  });

  it("verifyInviteToken rejects expired token", async () => {
    // We cannot actually wait 7 days, so we craft a token with a past expiresAt
    // signed with the known test secret (same construction as the library).
    const { createHmac } = await import("node:crypto");
    const pastExpiry = Date.now() - 1000;
    const payload = Buffer.from(`i1:expired@example.com:viewer:${pastExpiry}`).toString("base64url");
    const sig = createHmac("sha256", TEST_SECRET + ":invite").update(payload).digest("hex").substring(0, 32);
    const token = `${payload}.${sig}`;
    expect(auth.verifyInviteToken(token)).toBeNull();
  });
});

// --- Bearer Token Auth (BearerResolver replaces the Supabase /auth/v1/user fetch) ---

describe("Bearer Token Auth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bearer resolver result is returned as the session email", async () => {
    const bearerResolver = vi.fn().mockResolvedValue("user@example.com");
    const svc = makeAuth({ bearerResolver });

    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer valid-fake-token-123" },
    });
    const email = await svc.getSessionEmail(req);
    expect(email).toBe("user@example.com");
    expect(bearerResolver).toHaveBeenCalledWith("valid-fake-token-123");
  });

  it("returns null when the resolver rejects the token", async () => {
    const bearerResolver = vi.fn().mockResolvedValue(null);
    const svc = makeAuth({ bearerResolver });

    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(await svc.getSessionEmail(req)).toBeNull();
  });

  it("returns null when the resolver throws", async () => {
    const bearerResolver = vi.fn().mockRejectedValue(new Error("upstream down"));
    const svc = makeAuth({ bearerResolver });

    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer some-token" },
    });
    expect(await svc.getSessionEmail(req)).toBeNull();
  });

  it("returns null when no bearer resolver is configured", async () => {
    // Original: SUPABASE_URL unset → verifySupabaseToken returned null
    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer some-token" },
    });
    expect(await auth.getSessionEmail(req)).toBeNull();
  });

  it("uses cache on second call (no duplicate resolver invocation)", async () => {
    const bearerResolver = vi.fn().mockResolvedValue("cached@example.com");
    const svc = makeAuth({ bearerResolver });

    const uniqueToken = "cache-test-token-" + Date.now();
    const req1 = new Request("http://localhost/api/test", {
      headers: { Authorization: `Bearer ${uniqueToken}` },
    });
    expect(await svc.getSessionEmail(req1)).toBe("cached@example.com");
    expect(bearerResolver).toHaveBeenCalledTimes(1);

    // Second request with same token should hit cache
    const req2 = new Request("http://localhost/api/test", {
      headers: { Authorization: `Bearer ${uniqueToken}` },
    });
    expect(await svc.getSessionEmail(req2)).toBe("cached@example.com");
    // Should not have invoked the resolver again
    expect(bearerResolver).toHaveBeenCalledTimes(1);
  });

  it('extractBearerToken extracts token with "Bearer " prefix', async () => {
    const bearerResolver = vi.fn().mockResolvedValue("bearer@test.com");
    const svc = makeAuth({ bearerResolver });

    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer my-jwt-token" },
    });
    // If Bearer extraction works, checkAuth will consult the resolver
    expect(await svc.checkAuth(req)).toBe(true);
    expect(bearerResolver).toHaveBeenCalledWith("my-jwt-token");
  });

  it('extractBearerToken returns null without "Bearer " prefix', async () => {
    const bearerResolver = vi.fn().mockResolvedValue("should-not-happen@test.com");
    const svc = makeAuth({ bearerResolver });

    const req = new Request("http://localhost/api/test", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(await svc.checkAuth(req)).toBe(false);
    // No Bearer token → resolver never consulted
    expect(bearerResolver).not.toHaveBeenCalled();
  });

  it("checkAuth succeeds with Bearer when cookie fails", async () => {
    const bearerResolver = vi.fn().mockResolvedValue("bearer-fallback@test.com");
    const svc = makeAuth({ bearerResolver });

    // Expired cookie + valid Bearer token
    const expiredCookie = svc.signToken(`auth:${Date.now() - 3600000}`);
    const req = new Request("http://localhost/api/test", {
      headers: {
        Cookie: `session=${expiredCookie}`,
        Authorization: "Bearer valid-bearer-token",
      },
    });
    expect(await svc.checkAuth(req)).toBe(true);
  });

  it("evicts oldest entries when the cache is full", async () => {
    const bearerResolver = vi.fn().mockResolvedValue("evict@test.com");
    const svc = makeAuth({ bearerResolver, maxBearerCacheSize: 2 });
    const farFuture = Date.now() + 60_000;
    svc._testing.setTokenCache("t1", { email: "a@test.com", expires: farFuture });
    svc._testing.setTokenCache("t2", { email: "b@test.com", expires: farFuture });
    svc._testing.setTokenCache("t3", { email: "c@test.com", expires: farFuture });
    expect(svc._testing.tokenCache.size).toBeLessThanOrEqual(2);
    expect(svc._testing.tokenCache.has("t3")).toBe(true);
    expect(svc._testing.tokenCache.has("t1")).toBe(false);
  });
});

describe("E2E bypass injection", () => {
  it("checkAuth accepts a request matched by the injected bypass predicate", async () => {
    const svc = makeAuth({
      isBypassRequest: (req) => req.headers.get("X-E2E-Bypass") === "fake-bypass-token",
    });
    const req = new Request("http://localhost/api/test", {
      headers: { "X-E2E-Bypass": "fake-bypass-token" },
    });
    expect(await svc.checkAuth(req)).toBe(true);
    // Bypass identity resolves to "admin" (original sentinel behavior)
    expect(await svc.getSessionEmail(req)).toBe("admin");
  });
});

// --- Role Management (RoleResolver replaces dashboard_team_members lookup/insert) ---

describe("Role Management", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getOrCreateMember returns existing member role", async () => {
    const roleResolver = vi.fn().mockResolvedValue("editor");
    const svc = makeAuth({ roleResolver });
    const role = await svc.getOrCreateMember("editor@example.com");
    expect(role).toBe("editor");
    expect(roleResolver).toHaveBeenCalledWith("editor@example.com");
  });

  it('getOrCreateMember falls back to "member" when resolver finds no role', async () => {
    // Original: empty lookup → auto-insert with "member" and return it. The
    // auto-insert now lives in the caller's resolver; a null result falls back
    // to the adminEmail/member check.
    const roleResolver = vi.fn().mockResolvedValue(null);
    const svc = makeAuth({ roleResolver });
    const role = await svc.getOrCreateMember("newuser@example.com");
    expect(role).toBe("member");
  });

  it('getOrCreateMember assigns "admin" role when email matches adminEmail', async () => {
    // Original test was non-deterministic (ADMIN_EMAIL read at module init);
    // with injected config this is now exact.
    const roleResolver = vi.fn().mockResolvedValue(null);
    const svc = makeAuth({ roleResolver, adminEmail: "admin@test.com" });
    expect(await svc.getOrCreateMember("admin@test.com")).toBe("admin");
    expect(await svc.getOrCreateMember("someone-else@test.com")).toBe("member");
  });

  it("getOrCreateMember ignores unknown roles from the resolver", async () => {
    const roleResolver = vi.fn().mockResolvedValue("superuser");
    const svc = makeAuth({ roleResolver });
    expect(await svc.getOrCreateMember("user@example.com")).toBe("member");
  });

  it("getOrCreateMember falls back to email check when no resolver is configured", async () => {
    // Original: SUPABASE_URL empty → non-admin email gets "member"
    const role = await auth.getOrCreateMember("user@example.com");
    expect(role).toBe("member");
  });

  it("getOrCreateMember falls back on resolver error", async () => {
    const roleResolver = vi.fn().mockRejectedValue(new Error("Network error"));
    const svc = makeAuth({ roleResolver });
    const role = await svc.getOrCreateMember("user@example.com");
    // On resolver error, falls back to email === adminEmail check
    expect(role).toBe("member");
  });
});

describe("RBAC", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requireRole returns null when user has an allowed role", async () => {
    // createSessionCookie without email creates an "admin"-identity token
    const svc = makeAuth({ roleResolver: vi.fn().mockResolvedValue("admin") });
    const cookie = await svc.createSessionCookie();
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });

    const result = await svc.requireRole(req, "admin", "editor");
    expect(result).toBeNull(); // null = authorized
  });

  it("requireRole returns 403 when user lacks required role", async () => {
    const svc = makeAuth({ roleResolver: vi.fn().mockResolvedValue("viewer") });
    const cookie = await svc.createSessionCookie("viewer@example.com");
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });

    const result = await svc.requireRole(req, "admin", "editor");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.json();
    expect(body.error).toBeDefined();
    expect(body.required).toContain("admin");
    expect(body.current).toBe("viewer");
  });

  it("requireRole authorizes a higher role than the minimum allowed (hierarchy)", async () => {
    // Original issue #952: requireRole(req, "member") must not 403 admins
    const svc = makeAuth({ roleResolver: vi.fn().mockResolvedValue("admin") });
    const cookie = await svc.createSessionCookie("boss@example.com");
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });
    expect(await svc.requireRole(req, "member")).toBeNull();
  });

  it("requireSuperAdmin returns null for the adminEmail user", async () => {
    // Original test had to branch on ambient ADMIN_EMAIL; injected config makes it exact.
    const svc = makeAuth({ adminEmail: "owner@example.com" });
    const cookie = await svc.createSessionCookie("owner@example.com");
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });
    expect(await svc.requireSuperAdmin(req)).toBeNull();
  });

  it("requireSuperAdmin returns 403 when no adminEmail is configured", async () => {
    const cookie = await auth.createSessionCookie();
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });
    const result = await auth.requireSuperAdmin(req);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("requireSuperAdmin returns 403 for non-admin user", async () => {
    const svc = makeAuth({ adminEmail: "owner@example.com" });
    const cookie = await svc.createSessionCookie("regular@example.com");
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });
    const result = await svc.requireSuperAdmin(req);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("getSecureOrigin returns https when X-Forwarded-Proto is https", () => {
    const req = new Request("http://localhost/api/test", {
      headers: { "X-Forwarded-Proto": "https" },
    });
    const url = new URL("http://localhost/api/test");
    expect(getSecureOrigin(req, url)).toBe("https://localhost");
  });

  it("getSecureOrigin falls back to url.protocol when X-Forwarded-Proto is absent", () => {
    const req = new Request("http://localhost/api/test");
    const url = new URL("http://localhost/api/test");
    expect(getSecureOrigin(req, url)).toBe("http://localhost");
  });

  it("getSecureOrigin preserves port in host", () => {
    const req = new Request("http://localhost:3000/api/test", {
      headers: { "X-Forwarded-Proto": "https" },
    });
    const url = new URL("http://localhost:3000/api/test");
    expect(getSecureOrigin(req, url)).toBe("https://localhost:3000");
  });

  it("getCurrentUserRole returns admin for default session (no email)", async () => {
    const cookie = await auth.createSessionCookie();
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });
    // Default session has email "admin" → getCurrentUserRole returns admin role
    const { email, role } = await auth.getCurrentUserRole(req);
    expect(email).toBe("admin");
    expect(role).toBe("admin");
  });

  it("getCurrentUserRole returns member role for regular user", async () => {
    const svc = makeAuth({ roleResolver: vi.fn().mockResolvedValue("member") });
    const cookie = await svc.createSessionCookie("user@example.com");
    const req = new Request("http://localhost/api/test", {
      headers: { Cookie: `session=${cookie}` },
    });

    const { email, role } = await svc.getCurrentUserRole(req);
    expect(email).toBe("user@example.com");
    expect(role).toBe("member");
  });

  it("getCurrentUserRole returns admin for unauthenticated request", async () => {
    const req = new Request("http://localhost/api/test");
    // No session → getSessionEmail returns null → getCurrentUserRole defaults to admin
    const { email, role } = await auth.getCurrentUserRole(req);
    expect(email).toBe("admin");
    expect(role).toBe("admin");
  });
});
