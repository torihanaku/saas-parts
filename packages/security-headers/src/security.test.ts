import { describe, it, expect } from "vitest";
import {
  DEFAULT_CSP,
  RELAXED_CSP,
  securityHeadersFor,
  corsHeadersFor,
  corsPreflightHeadersFor,
  checkCsrfOrigin,
  evaluateCors,
  isCrossOriginProtocolPath,
  type SecurityConfig,
} from "./index";
import { addSecurityHeaders, addCorsHeaders, handleCors } from "./adapter";

// Fake fixture — stands in for the source project's env-derived CORS_ORIGIN.
const config: SecurityConfig = {
  allowedOrigins: ["http://localhost:5173", "https://app.example.test"],
};

describe("Security Headers (pure)", () => {
  it("adds X-Frame-Options DENY", () => {
    const headers = securityHeadersFor(config, { path: "/api/state" });
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });

  it("adds X-Content-Type-Options nosniff", () => {
    const headers = securityHeadersFor(config, { path: "/api/state" });
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("adds Referrer-Policy", () => {
    const headers = securityHeadersFor(config, { path: "/api/state" });
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("adds Permissions-Policy", () => {
    const headers = securityHeadersFor(config, { path: "/" });
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Permissions-Policy"]).toContain("interest-cohort=()");
  });

  it("adds HSTS when X-Forwarded-Proto is https", () => {
    const headers = securityHeadersFor(config, { path: "/", forwardedProto: "https" });
    expect(headers["Strict-Transport-Security"]).toContain("max-age=31536000");
  });

  it("does not add HSTS without X-Forwarded-Proto", () => {
    const headers = securityHeadersFor(config, { path: "/" });
    expect(headers["Strict-Transport-Security"]).toBeUndefined();
  });

  it("serves the strict CSP by default", () => {
    const headers = securityHeadersFor(config, { path: "/api/state" });
    expect(headers["Content-Security-Policy"]).toBe(DEFAULT_CSP);
    expect(headers["Content-Security-Policy"]).toContain("script-src 'self';");
  });

  it("relaxes CSP on /login and /auth/ paths (source defaults)", () => {
    for (const path of ["/login", "/auth/google"]) {
      const headers = securityHeadersFor(config, { path });
      expect(headers["Content-Security-Policy"]).toBe(RELAXED_CSP);
      expect(headers["Content-Security-Policy"]).toContain("script-src 'self' 'unsafe-inline'");
    }
  });

  it("honors custom CSP relaxation paths from config", () => {
    const custom: SecurityConfig = { ...config, relaxedCspPathPrefixes: ["/embed/"] };
    expect(securityHeadersFor(custom, { path: "/embed/widget" })["Content-Security-Policy"]).toBe(RELAXED_CSP);
    expect(securityHeadersFor(custom, { path: "/login" })["Content-Security-Policy"]).toBe(DEFAULT_CSP);
  });

  it("sets X-API-Version on versioned endpoints only", () => {
    expect(securityHeadersFor(config, { path: "/api/v1/state" })["X-API-Version"]).toBe("1");
    expect(securityHeadersFor(config, { path: "/api/v1" })["X-API-Version"]).toBe("1");
    expect(securityHeadersFor(config, { path: "/api/v10/state" })["X-API-Version"]).toBeUndefined();
    expect(securityHeadersFor(config, { path: "/api/state" })["X-API-Version"]).toBeUndefined();
  });

  it("sets X-Request-Id and X-Correlation-Id when requestId is given", () => {
    const headers = securityHeadersFor(config, { path: "/", requestId: "req-123" });
    expect(headers["X-Request-Id"]).toBe("req-123");
    expect(headers["X-Correlation-Id"]).toBe("req-123");
  });
});

describe("Security Headers (Fetch adapter)", () => {
  it("preserves original response status", () => {
    const response = new Response("not found", { status: 404 });
    const secured = addSecurityHeaders(config, response);
    expect(secured.status).toBe(404);
  });

  it("preserves original response headers", () => {
    const response = new Response("test", {
      headers: { "Content-Type": "application/json", "X-Custom": "value" },
    });
    const secured = addSecurityHeaders(config, response);
    expect(secured.headers.get("Content-Type")).toBe("application/json");
    expect(secured.headers.get("X-Custom")).toBe("value");
    expect(secured.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("adds HSTS when the request came through an HTTPS proxy", () => {
    const req = new Request("http://localhost", {
      headers: { "X-Forwarded-Proto": "https" },
    });
    const secured = addSecurityHeaders(config, new Response("test"), req);
    expect(secured.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");
  });

  it("does not add HSTS without X-Forwarded-Proto", () => {
    const secured = addSecurityHeaders(config, new Response("test"), new Request("http://localhost"));
    expect(secured.headers.get("Strict-Transport-Security")).toBeNull();
  });
});

describe("CORS", () => {
  it("handles OPTIONS preflight", () => {
    const result = evaluateCors(config, { method: "OPTIONS", path: "/api/test" });
    expect(result.kind).toBe("preflight");
    if (result.kind !== "preflight") throw new Error("unreachable");
    expect(result.status).toBe(204);
    expect(result.headers["Access-Control-Allow-Methods"]).toContain("GET");
    expect(result.headers["Access-Control-Allow-Methods"]).toContain("POST");
  });

  it("preflight echoes an allowed origin, falls back to first allowed origin", () => {
    const withOrigin = corsPreflightHeadersFor(config, { origin: "https://app.example.test" });
    expect(withOrigin["Access-Control-Allow-Origin"]).toBe("https://app.example.test");
    expect(withOrigin["Access-Control-Allow-Headers"]).toBe("Content-Type, Authorization, X-E2E-Bypass");
    expect(withOrigin["Access-Control-Max-Age"]).toBe("86400");
    const noOrigin = corsPreflightHeadersFor(config, {});
    expect(noOrigin["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
  });

  it("passes through non-OPTIONS requests", () => {
    const result = evaluateCors(config, { method: "GET", path: "/api/test" });
    expect(result.kind).toBe("pass");
  });

  it("blocks cross-origin POST to regular API with forbidden origin", () => {
    const result = evaluateCors(config, {
      method: "POST",
      path: "/api/state",
      origin: "https://evil.example.com",
    });
    expect(result.kind).toBe("forbidden");
    if (result.kind !== "forbidden") throw new Error("unreachable");
    expect(result.status).toBe(403);
    expect(result.reason).toBe("origin-not-allowed");
  });

  it("allows SAML ACS POST from IdP origin (cross-origin by protocol)", () => {
    // Google Workspace / Okta POST the signed SAML assertion from their own
    // origin. The SAML signature is the real security check, not the browser
    // origin. Without this exception, all SAML logins would return 403.
    const result = evaluateCors(config, {
      method: "POST",
      path: "/auth/saml/acs/abc-123",
      origin: "https://accounts.google.com",
    });
    expect(result.kind).toBe("pass");
  });

  it("allows Google OAuth callback from accounts.google.com", () => {
    const result = evaluateCors(config, {
      method: "GET",
      path: "/auth/google/callback",
      origin: "https://accounts.google.com",
    });
    expect(result.kind).toBe("pass");
  });

  it("allows generic OIDC SSO callback from cross-origin IdP", () => {
    const result = evaluateCors(config, {
      method: "GET",
      path: "/auth/sso/callback/xyz",
      origin: "https://login.microsoftonline.com",
    });
    expect(result.kind).toBe("pass");
  });

  it("adds CORS headers only for allow-listed origins", () => {
    expect(corsHeadersFor(config, { origin: "https://app.example.test" })).toEqual({
      "Access-Control-Allow-Origin": "https://app.example.test",
      "Access-Control-Allow-Credentials": "true",
    });
    expect(corsHeadersFor(config, { origin: "https://evil.example.com" })).toEqual({});
    expect(corsHeadersFor(config, { origin: "" })).toEqual({});
  });
});

describe("CSRF origin check", () => {
  it("requires Origin on mutating requests carrying a session cookie", () => {
    const result = checkCsrfOrigin(config, {
      method: "POST",
      path: "/api/state",
      origin: "",
      cookie: "session=fake-session-value",
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.status).toBe(403);
    expect(result.reason).toBe("origin-required");
  });

  it("allows mutating requests without a session cookie even when Origin is absent", () => {
    const result = checkCsrfOrigin(config, { method: "POST", path: "/api/state", origin: "" });
    expect(result.allowed).toBe(true);
  });

  it("allows GET without Origin even with a session cookie", () => {
    const result = checkCsrfOrigin(config, {
      method: "GET",
      path: "/api/state",
      origin: "",
      cookie: "session=fake-session-value",
    });
    expect(result.allowed).toBe(true);
  });

  it("skips the Origin requirement for protocol callbacks (SAML ACS)", () => {
    const result = checkCsrfOrigin(config, {
      method: "POST",
      path: "/auth/saml/acs/abc-123",
      origin: "",
      cookie: "session=fake-session-value",
    });
    expect(result.allowed).toBe(true);
  });

  it("uses the configured session cookie name", () => {
    const custom: SecurityConfig = { ...config, sessionCookieName: "sid" };
    const denied = checkCsrfOrigin(custom, {
      method: "POST",
      path: "/api/state",
      origin: "",
      cookie: "sid=fake",
    });
    expect(denied.allowed).toBe(false);
    const allowed = checkCsrfOrigin(custom, {
      method: "POST",
      path: "/api/state",
      origin: "",
      cookie: "session=fake",
    });
    expect(allowed.allowed).toBe(true);
  });
});

describe("isCrossOriginProtocolPath", () => {
  it("matches /auth/saml/acs/ with provider id", () => {
    expect(isCrossOriginProtocolPath("/auth/saml/acs/abc-123")).toBe(true);
    expect(isCrossOriginProtocolPath("/auth/saml/acs/812be0a2-cf93-4c5a-a4a2-c8dfdb3e8ef3")).toBe(true);
  });

  it("matches /auth/google/callback exactly", () => {
    // Note: callers pass URL.pathname which strips query strings, so we only
    // match on the pathname prefix itself.
    expect(isCrossOriginProtocolPath("/auth/google/callback")).toBe(true);
  });

  it("matches /auth/sso/callback/ with provider id", () => {
    expect(isCrossOriginProtocolPath("/auth/sso/callback/xyz")).toBe(true);
    expect(isCrossOriginProtocolPath("/auth/sso/callback/")).toBe(true);
  });

  it("does not match SAML non-ACS paths", () => {
    expect(isCrossOriginProtocolPath("/auth/saml/login/abc")).toBe(false);
    expect(isCrossOriginProtocolPath("/auth/saml/metadata/abc")).toBe(false);
  });

  it("does not match regular auth / api paths", () => {
    expect(isCrossOriginProtocolPath("/auth/google")).toBe(false);
    expect(isCrossOriginProtocolPath("/auth/logout")).toBe(false);
    expect(isCrossOriginProtocolPath("/api/state")).toBe(false);
    expect(isCrossOriginProtocolPath("/login")).toBe(false);
    expect(isCrossOriginProtocolPath("/")).toBe(false);
  });

  it("requires trailing slash for /auth/saml/acs/ and /auth/sso/callback/", () => {
    // /auth/saml/acs (no slash) should not match — avoids matching hypothetical /auth/saml/acsXXX paths
    expect(isCrossOriginProtocolPath("/auth/saml/acs")).toBe(false);
    expect(isCrossOriginProtocolPath("/auth/sso/callback")).toBe(false);
  });

  it("honors custom callback prefixes from config", () => {
    const custom: SecurityConfig = { callbackPathPrefixes: ["/hooks/idp/"] };
    expect(isCrossOriginProtocolPath("/hooks/idp/abc", custom)).toBe(true);
    expect(isCrossOriginProtocolPath("/auth/saml/acs/abc", custom)).toBe(false);
  });
});

describe("Fetch adapter handleCors (port of source handleCors)", () => {
  it("handles OPTIONS preflight", () => {
    const req = new Request("http://localhost/api/test", { method: "OPTIONS" });
    const response = handleCors(config, req);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(204);
    expect(response!.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(response!.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("returns null for non-OPTIONS requests", () => {
    const req = new Request("http://localhost/api/test", { method: "GET" });
    expect(handleCors(config, req)).toBeNull();
  });

  it("blocks cross-origin POST with forbidden origin (403 text/plain)", async () => {
    const req = new Request("http://localhost/api/state", {
      method: "POST",
      headers: { Origin: "https://evil.example.com" },
    });
    const response = handleCors(config, req);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
    expect(response!.headers.get("Content-Type")).toBe("text/plain");
    await expect(response!.text()).resolves.toBe("Forbidden: origin not allowed");
  });

  it("allows SAML ACS POST from IdP origin", () => {
    const req = new Request("http://localhost/auth/saml/acs/abc-123", {
      method: "POST",
      headers: {
        Origin: "https://accounts.google.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "SAMLResponse=dummy",
    });
    expect(handleCors(config, req)).toBeNull();
  });

  it("requires Origin on mutating requests with a session cookie", async () => {
    const req = new Request("http://localhost/api/state", {
      method: "POST",
      headers: { Cookie: "session=fake-session-value" },
    });
    const response = handleCors(config, req);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
    await expect(response!.text()).resolves.toBe("Forbidden: Origin header required for mutating requests");
  });

  it("addCorsHeaders sets ACAO only for allow-listed origins", () => {
    const base = new Response("ok");
    const allowed = addCorsHeaders(config, base, "https://app.example.test");
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.test");
    expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    const denied = addCorsHeaders(config, new Response("ok"), "https://evil.example.com");
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
