/**
 * Response helpers and utility functions for fetch-style HTTP servers
 * (Bun.serve / Cloudflare Workers / any Request-Response runtime with node compat).
 *
 * Ported from 実運用SaaS server/lib/helpers.ts.
 */
import { gzipSync } from "zlib";
import { createHash } from "crypto";

/** Compress JSON with gzip if client accepts it and payload > 1KB */
export function jsonResponse(data: unknown, req: Request, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const json = JSON.stringify(data);
  const acceptEncoding = req.headers.get("Accept-Encoding") || "";
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (json.length > 1024 && acceptEncoding.includes("gzip")) {
    const compressed = gzipSync(Buffer.from(json));
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    return new Response(compressed, { status, headers });
  }
  return new Response(json, { status, headers });
}

/** Generate a weak ETag from data */
export function generateETag(data: unknown): string {
  const hash = createHash("md5").update(JSON.stringify(data)).digest("hex");
  return `W/"${hash.substring(0, 16)}"`;
}

/** Return 304 if ETag matches, or null to proceed */
export function checkConditionalRequest(req: Request, etag: string): Response | null {
  const ifNoneMatch = req.headers.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { "ETag": etag } });
  }
  return null;
}

/** Parse pagination params: ?page=1&limit=20 */
export function parsePagination(url: URL, defaultLimit = 20, maxLimit = 100): { page: number; limit: number; offset: number } {
  // parseInt returns NaN for non-numeric input (e.g. ?page=abc). Math.max/min
  // propagate NaN silently, which would flow into SQL `LIMIT NaN` / `OFFSET NaN`.
  // Coerce NaN back to the safe default before clamping.
  const rawPage = parseInt(url.searchParams.get("page") ?? "", 10);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "", 10);
  const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage);
  const limit = Math.min(maxLimit, Math.max(1, Number.isNaN(rawLimit) ? defaultLimit : rawLimit));
  return { page, limit, offset: (page - 1) * limit };
}

/** Build paginated response envelope */
export function paginatedResponse(items: unknown[], total: number, page: number, limit: number): Record<string, unknown> {
  return { data: items, total_count: total, page, per_page: limit, has_next: page * limit < total };
}

/**
 * fetch() wrapper with AbortController-based timeout.
 * NOTE: Raw fetch() with no timeout can hang indefinitely on flaky external APIs
 * (Anthropic, Slack, GitHub, Google OAuth). This wrapper adds a hard deadline.
 * @param url - The URL to fetch
 * @param options - Standard RequestInit options
 * @param timeoutMs - Timeout in milliseconds (default: 30s)
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit = {},
  timeoutMs = 30_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Content-Type inference from file extension */
export function getContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".woff")) return "font/woff";
  return "application/octet-stream";
}
