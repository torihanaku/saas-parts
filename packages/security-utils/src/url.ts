/** Max length for webhook/external URLs */
const MAX_URL_LENGTH = 2048;

/**
 * Private/internal hostname patterns used to prevent SSRF attacks.
 * Blocks localhost, RFC 1918 ranges, link-local, IPv6 private,
 * and cloud metadata endpoints.
 */
const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/,
  /^fd/,
  /^fe80:/,
  /\.local$/,
  /\.internal$/,
  /\.localhost$/,
  /^metadata\.google\.internal$/,
];

/**
 * Validate that a webhook URL is safe: must be HTTPS and not target private/internal IPs.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateWebhookUrl(url: string): string | null {
  if (url.length > MAX_URL_LENGTH) {
    return "URL exceeds maximum length";
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL format";
  }

  if (parsed.protocol !== "https:") {
    return "Webhook URL must use HTTPS";
  }

  // Block private/internal hostnames and IPs
  // URL parser wraps IPv6 in brackets — strip them for pattern matching
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  for (const pattern of PRIVATE_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      return "Webhook URL must not target private or internal addresses";
    }
  }

  return null; // valid
}

const DEFAULT_TIMEOUT_MS = 3000;

export interface HeadCheckResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

/**
 * Perform a SSRF-safe HEAD request to verify the URL is reachable.
 * Reuses validateWebhookUrl() for HTTPS-only + private-IP block, then
 * issues a HEAD with a short timeout. Treats 2xx/3xx as ok.
 * Never throws — returns structured result for the caller to log.
 */
export async function headCheck(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<HeadCheckResult> {
  const preFlight = validateWebhookUrl(url);
  if (preFlight !== null) {
    return { ok: false, reason: preFlight };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
    });
    if (res.status >= 200 && res.status < 400) {
      return { ok: true, status: res.status };
    }
    return { ok: false, status: res.status, reason: `non-success status ${res.status}` };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: `timeout after ${timeoutMs}ms` };
    }
    return { ok: false, reason: err instanceof Error ? err.message : "fetch failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate a list of URLs in parallel. Returns the subset that passed HEAD check,
 * in the original order. Invalid URLs are logged via the provided logger (or console.warn).
 */
export async function filterReachableUrls(
  urls: string[],
  opts: { timeoutMs?: number; onReject?: (url: string, reason: string) => void } = {}
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onReject =
    opts.onReject ??
    ((url: string, reason: string) =>
      console.warn(
        JSON.stringify({ severity: "WARNING", message: "url_rejected", url, reason })
      ));

  const results = await Promise.all(urls.map((u) => headCheck(u, timeoutMs)));
  const kept: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const r = results[i];
    const url = urls[i];
    if (r === undefined || url === undefined) continue;
    if (r.ok) {
      kept.push(url);
    } else {
      onReject(url, r.reason ?? `status=${r.status}`);
    }
  }
  return kept;
}
