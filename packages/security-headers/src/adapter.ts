/**
 * Thin adapter for the standard Fetch API (`Request` / `Response`).
 *
 * Reproduces the source middleware's `addSecurityHeaders` / `addCorsHeaders` /
 * `handleCors` signatures on top of the pure functions in `security.ts`,
 * with the config injected instead of read from env.
 *
 * Works on any runtime with Fetch API globals (Node >= 18, Bun, Deno, workers).
 */

import {
  checkCsrfOrigin,
  corsHeadersFor,
  corsPreflightHeadersFor,
  securityHeadersFor,
  type SecurityConfig,
} from "./security";

function pathnameOf(req: Request): string {
  return new URL(req.url, "http://localhost").pathname;
}

function withHeaders(response: Response, headers: Headers): Response {
  try {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }
}

/** Add security headers to a Response (port of the source's `addSecurityHeaders`). */
export function addSecurityHeaders(
  config: SecurityConfig,
  response: Response,
  req?: Request,
  requestId?: string,
): Response {
  const headers = new Headers(response.headers);
  const computed = securityHeadersFor(config, {
    path: req ? pathnameOf(req) : "",
    forwardedProto: req?.headers.get("X-Forwarded-Proto"),
    requestId,
  });
  for (const [name, value] of Object.entries(computed)) {
    headers.set(name, value);
  }
  return withHeaders(response, headers);
}

/** Add CORS headers to a regular (non-preflight) response (port of `addCorsHeaders`). */
export function addCorsHeaders(config: SecurityConfig, response: Response, origin: string): Response {
  const computed = corsHeadersFor(config, { origin });
  if (Object.keys(computed).length === 0) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(computed)) {
    headers.set(name, value);
  }
  return withHeaders(response, headers);
}

/**
 * Handle CORS preflight and CSRF origin checks (port of `handleCors`).
 * Returns a short-circuit Response (403 or 204 preflight) or `null` to continue.
 */
export function handleCors(config: SecurityConfig, req: Request): Response | null {
  const origin = req.headers.get("Origin") || "";
  const decision = checkCsrfOrigin(config, {
    method: req.method,
    path: pathnameOf(req),
    origin,
    cookie: req.headers.get("Cookie"),
  });
  if (!decision.allowed) {
    return new Response(decision.message, {
      status: decision.status,
      headers: { "Content-Type": "text/plain" },
    });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsPreflightHeadersFor(config, { origin }),
    });
  }
  return null;
}
