/**
 * Framework-agnostic security header / CORS / CSRF-origin logic.
 *
 * Ported from dev-dashboard-v2 `server/middleware/security.ts` (Fetch-API
 * coupled middleware). Header values, CSP directives, CORS logic and CSRF
 * decision logic are preserved verbatim; the framework coupling and the
 * hardcoded values (allowed origins, SAML/OAuth callback exemptions, CSP
 * relaxation paths) were lifted into a config object.
 *
 * No environment variables are read here — the caller injects everything.
 */

/** A plain record of HTTP headers to set on a response. */
export type HeadersRecord = Record<string, string>;

/**
 * Library configuration. All fields optional; defaults reproduce the source
 * project's behavior (except `allowedOrigins`, which in the source came from
 * `CORS_ORIGIN` / `APP_URL` env vars with a `http://localhost:5173` fallback).
 */
export interface SecurityConfig {
  /**
   * Origins allowed for CORS (exact string match against the `Origin` header).
   * Source example: `["https://dev.folia.la"]` (from `CORS_ORIGIN`, comma-separated).
   * Default: `["http://localhost:5173"]` (the source's dev fallback).
   */
  allowedOrigins?: string[];
  /**
   * Path prefixes that are cross-origin by protocol design and must bypass
   * the origin allow-list. SAML 2.0 HTTP-POST binding requires the IdP
   * (e.g. Google Workspace, Okta) to POST the signed assertion to the ACS URL
   * from its own origin. OAuth callbacks are GETs but some providers send
   * Origin headers. Security for these endpoints relies on the SAML
   * signature / OAuth state, not on the browser origin.
   * Source values (default): `["/auth/saml/acs/", "/auth/google/callback", "/auth/sso/callback/"]`
   */
  callbackPathPrefixes?: string[];
  /**
   * Path prefixes served with the relaxed CSP (login/auth pages that use
   * inline scripts). Source values (default): `["/login", "/auth/"]`
   */
  relaxedCspPathPrefixes?: string[];
  /** Strict CSP string. Default: the source project's CSP (see DEFAULT_CSP). */
  defaultCsp?: string;
  /** Relaxed CSP string (adds `'unsafe-inline'` to script-src). Default: source value. */
  relaxedCsp?: string;
  /**
   * Session cookie name checked by the CSRF origin guard.
   * Default: `"session"` (source checked `Cookie` includes `"session="`).
   */
  sessionCookieName?: string;
  /**
   * Path prefix that triggers the `X-API-Version` response header.
   * Source behavior (default `"/api/v1"`): set when path === prefix or
   * path startsWith `prefix + "/"`.
   */
  apiVersionPathPrefix?: string;
  /** Value for the `X-API-Version` header. Default: `"1"`. */
  apiVersion?: string;
  /** `Access-Control-Allow-Methods` for preflight. Default: source value. */
  corsAllowMethods?: string;
  /** `Access-Control-Allow-Headers` for preflight. Default: source value. */
  corsAllowHeaders?: string;
  /** `Access-Control-Max-Age` for preflight. Default: `"86400"`. */
  corsMaxAge?: string;
}

/** Strict CSP applied to every path except {@link SecurityConfig.relaxedCspPathPrefixes}. */
export const DEFAULT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://*.supabase.co https://oauth2.googleapis.com https://www.googleapis.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/** Relaxed CSP for login/auth paths that use inline styles/scripts. */
export const RELAXED_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://*.supabase.co https://oauth2.googleapis.com https://www.googleapis.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/** Source project's cross-origin protocol callback path prefixes. */
export const DEFAULT_CALLBACK_PATH_PREFIXES = [
  "/auth/saml/acs/",
  "/auth/google/callback",
  "/auth/sso/callback/",
] as const;

/** Source project's CSP relaxation path prefixes. */
export const DEFAULT_RELAXED_CSP_PATH_PREFIXES = ["/login", "/auth/"] as const;

/** Fully-resolved configuration (every field required). */
export type ResolvedSecurityConfig = Required<SecurityConfig>;

/** Fill in defaults. Defaults reproduce the source project's hardcoded values. */
export function resolveConfig(config: SecurityConfig = {}): ResolvedSecurityConfig {
  return {
    allowedOrigins: config.allowedOrigins ?? ["http://localhost:5173"],
    callbackPathPrefixes: config.callbackPathPrefixes ?? [...DEFAULT_CALLBACK_PATH_PREFIXES],
    relaxedCspPathPrefixes: config.relaxedCspPathPrefixes ?? [...DEFAULT_RELAXED_CSP_PATH_PREFIXES],
    defaultCsp: config.defaultCsp ?? DEFAULT_CSP,
    relaxedCsp: config.relaxedCsp ?? RELAXED_CSP,
    sessionCookieName: config.sessionCookieName ?? "session",
    apiVersionPathPrefix: config.apiVersionPathPrefix ?? "/api/v1",
    apiVersion: config.apiVersion ?? "1",
    corsAllowMethods: config.corsAllowMethods ?? "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    corsAllowHeaders: config.corsAllowHeaders ?? "Content-Type, Authorization, X-E2E-Bypass",
    corsMaxAge: config.corsMaxAge ?? "86400",
  };
}

const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * True when the pathname is a cross-origin protocol callback (SAML ACS,
 * OAuth/OIDC callback) that must bypass the origin allow-list.
 * Matching is `startsWith` on each configured prefix (exactly as in source).
 */
export function isCrossOriginProtocolPath(pathname: string, config: SecurityConfig = {}): boolean {
  const { callbackPathPrefixes } = resolveConfig(config);
  return callbackPathPrefixes.some((prefix) => pathname.startsWith(prefix));
}

/** Request facts needed to compute security headers. */
export interface SecurityHeadersInput {
  /** URL pathname (no query string), e.g. `"/api/state"`. Default `""`. */
  path?: string;
  /** Value of the `X-Forwarded-Proto` request header; HSTS is emitted only when `"https"`. */
  forwardedProto?: string | null;
  /** Request/correlation id; emitted as `X-Request-Id` / `X-Correlation-Id` when set. */
  requestId?: string;
}

/**
 * Compute the security response headers for a request.
 * Pure function: returns a headers record to merge onto the response.
 */
export function securityHeadersFor(
  config: SecurityConfig = {},
  input: SecurityHeadersInput = {},
): HeadersRecord {
  const cfg = resolveConfig(config);
  const path = input.path ?? "";
  const headers: HeadersRecord = {};

  // CSP — relaxed for login/auth paths that use inline styles/scripts
  if (cfg.relaxedCspPathPrefixes.some((prefix) => path.startsWith(prefix))) {
    headers["Content-Security-Policy"] = cfg.relaxedCsp;
  } else {
    headers["Content-Security-Policy"] = cfg.defaultCsp;
  }

  // Prevent clickjacking
  headers["X-Frame-Options"] = "DENY";
  // Prevent MIME sniffing
  headers["X-Content-Type-Options"] = "nosniff";
  // Referrer policy
  headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
  // Request tracing
  if (input.requestId) {
    headers["X-Request-Id"] = input.requestId;
    headers["X-Correlation-Id"] = input.requestId;
  }
  // Permissions policy
  headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), interest-cohort=()";
  // API versioning header — set when client explicitly requested a versioned endpoint
  if (path.startsWith(`${cfg.apiVersionPathPrefix}/`) || path === cfg.apiVersionPathPrefix) {
    headers["X-API-Version"] = cfg.apiVersion;
  }
  // HSTS (only when behind HTTPS proxy)
  if (input.forwardedProto === "https") {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }

  return headers;
}

/**
 * CORS headers for a regular (non-preflight) response.
 * Returns `{}` when the origin is missing or not in the allow-list
 * (the source returned the response unchanged in that case).
 */
export function corsHeadersFor(config: SecurityConfig, input: { origin?: string | null }): HeadersRecord {
  const cfg = resolveConfig(config);
  const origin = input.origin ?? "";
  if (!origin || !cfg.allowedOrigins.includes(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
  };
}

/** Headers for a CORS preflight (OPTIONS) 204 response. */
export function corsPreflightHeadersFor(
  config: SecurityConfig,
  input: { origin?: string | null } = {},
): HeadersRecord {
  const cfg = resolveConfig(config);
  return {
    "Access-Control-Allow-Origin": input.origin || cfg.allowedOrigins[0] || "",
    "Access-Control-Allow-Methods": cfg.corsAllowMethods,
    "Access-Control-Allow-Headers": cfg.corsAllowHeaders,
    "Access-Control-Max-Age": cfg.corsMaxAge,
  };
}

/** Request facts needed for the CORS / CSRF-origin decision. */
export interface CsrfOriginInput {
  /** HTTP method, e.g. `"POST"`. */
  method: string;
  /** URL pathname (no query string). */
  path: string;
  /** Value of the `Origin` request header (empty/undefined when absent). */
  origin?: string | null;
  /** Raw `Cookie` request header (used to detect a session cookie). */
  cookie?: string | null;
}

/** Outcome of {@link checkCsrfOrigin}. */
export type CsrfOriginDecision =
  | { allowed: true }
  | {
      allowed: false;
      status: 403;
      reason: "origin-not-allowed" | "origin-required";
      message: string;
    };

/**
 * Origin allow-list + CSRF origin check (decision only, no Response).
 *
 * 1. If an `Origin` header is present and not in the allow-list, deny —
 *    except for cross-origin protocol callbacks (SAML ACS / OAuth callbacks).
 * 2. CSRF defense: require an Origin header on mutating requests that carry
 *    a session cookie. SameSite=Lax already blocks most CSRF, but this closes
 *    the remaining gap for requests made without an Origin header (e.g. old
 *    browser quirks, subdomain issues). Skipped for SAML/OAuth callbacks
 *    which carry their own protocol-level CSRF protection.
 */
export function checkCsrfOrigin(config: SecurityConfig, input: CsrfOriginInput): CsrfOriginDecision {
  const cfg = resolveConfig(config);
  const origin = input.origin ?? "";
  const isProtocolCallback = isCrossOriginProtocolPath(input.path, cfg);

  // Validate origin against allowed list, except for cross-origin protocol callbacks
  if (origin && !cfg.allowedOrigins.includes(origin) && !isProtocolCallback) {
    return {
      allowed: false,
      status: 403,
      reason: "origin-not-allowed",
      message: "Forbidden: origin not allowed",
    };
  }

  const hasCookie = (input.cookie ?? "").includes(`${cfg.sessionCookieName}=`);
  if (MUTATING_METHODS.includes(input.method) && hasCookie && !origin && !isProtocolCallback) {
    return {
      allowed: false,
      status: 403,
      reason: "origin-required",
      message: "Forbidden: Origin header required for mutating requests",
    };
  }

  return { allowed: true };
}

/** Outcome of {@link evaluateCors} — the full port of the source's `handleCors`. */
export type CorsEvaluation =
  /** Deny with 403 (body = `message`, `Content-Type: text/plain`). */
  | { kind: "forbidden"; status: 403; reason: "origin-not-allowed" | "origin-required"; message: string }
  /** Answer the OPTIONS preflight with 204 and these headers. */
  | { kind: "preflight"; status: 204; headers: HeadersRecord }
  /** Continue normal request handling. */
  | { kind: "pass" };

/**
 * Full CORS/CSRF gate for an incoming request (decision only).
 * Order matches the source: origin allow-list check, then CSRF origin
 * requirement, then OPTIONS preflight short-circuit.
 */
export function evaluateCors(config: SecurityConfig, input: CsrfOriginInput): CorsEvaluation {
  const decision = checkCsrfOrigin(config, input);
  if (!decision.allowed) {
    return { kind: "forbidden", status: 403, reason: decision.reason, message: decision.message };
  }
  if (input.method === "OPTIONS") {
    return {
      kind: "preflight",
      status: 204,
      headers: corsPreflightHeadersFor(config, { origin: input.origin }),
    };
  }
  return { kind: "pass" };
}
