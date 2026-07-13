/** Max length for webhook/external URLs */
const MAX_URL_LENGTH = 2048;

/**
 * Private/internal hostname patterns used to prevent SSRF attacks.
 * Blocks localhost, RFC 1918 ranges, link-local, IPv6 private,
 * and cloud metadata endpoints.
 *
 * NOTE: this is a *first-line, string-only* filter. It cannot catch a public
 * hostname that RESOLVES to a private address (DNS rebinding / attacker-controlled
 * DNS). That class of bypass is closed at request time by {@link headCheck}, which
 * resolves the hostname and rejects any private resolved IP. Keep both layers.
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
 * Returns true when an IP address (v4, v6, or IPv4-mapped IPv6) points at a
 * private, loopback, link-local, or otherwise non-public range. Used to vet
 * DNS-resolved addresses so a public hostname cannot be pointed at an internal
 * target (SSRF via DNS). Malformed input is treated as unsafe (returns true).
 */
export function isPrivateIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  if (!addr) return true;

  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1 — vet the embedded IPv4.
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  const v4 = mapped ? mapped[1]! : addr;

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4)) {
    const parts = v4.split(".").map((p) => Number(p));
    if (parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true; // "this" network / 0.0.0.0
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
    return false;
  }

  // IPv6
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // fc00::/7 unique-local
  if (addr.startsWith("fe80")) return true; // link-local
  return false;
}

/**
 * Validate that a webhook URL is safe: must be HTTPS and not target private/internal IPs.
 * Returns an error message string if invalid, or null if valid.
 *
 * This is the synchronous first-line check (no DNS). For full SSRF safety the
 * caller must also go through {@link headCheck}, which resolves DNS and blocks
 * redirects to internal targets.
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

/** Resolve a hostname to its IP addresses. Injectable so tests need no real DNS. */
export type DnsLookup = (hostname: string) => Promise<string[]>;

let cachedDefaultLookup: DnsLookup | null = null;

/**
 * Default resolver backed by node:dns. Loaded lazily so the module stays usable
 * in non-node runtimes that never call headCheck without an injected lookup.
 */
async function defaultLookup(hostname: string): Promise<string[]> {
  if (!cachedDefaultLookup) {
    const dns = await import("node:dns/promises");
    cachedDefaultLookup = async (h: string) => {
      const records = await dns.lookup(h, { all: true });
      return records.map((r) => r.address);
    };
  }
  return cachedDefaultLookup(hostname);
}

export interface HeadCheckResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export interface HeadCheckOptions {
  /** Injectable DNS resolver (default: node:dns lookup, all addresses). */
  lookup?: DnsLookup;
}

/**
 * Perform a SSRF-safe HEAD request to verify the URL is reachable.
 *
 * Defense layers:
 *  1. {@link validateWebhookUrl} — HTTPS-only + private-hostname string block.
 *  2. DNS resolution — reject if ANY resolved IP is private/internal
 *     (closes the DNS-rebinding / attacker-DNS bypass).
 *  3. `redirect: "manual"` — a validated URL cannot 3xx-redirect the request
 *     onto an internal address; redirects are reported, never followed.
 *
 * Never throws — returns a structured result for the caller to log.
 */
export async function headCheck(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  opts: HeadCheckOptions = {}
): Promise<HeadCheckResult> {
  const preFlight = validateWebhookUrl(url);
  if (preFlight !== null) {
    return { ok: false, reason: preFlight };
  }

  // Resolve DNS and vet every address — a public hostname must not point at an
  // internal target. IP-literal hosts resolve to themselves (no network call).
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const lookup = opts.lookup ?? defaultLookup;
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    return { ok: false, reason: `dns resolution failed: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "dns resolution returned no addresses" };
  }
  if (addresses.some(isPrivateIp)) {
    return { ok: false, reason: "Webhook URL must not target private or internal addresses" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      // Do NOT follow redirects: a 3xx to an internal address would bypass the
      // checks above. Treat a redirect as "reachable" without chasing it.
      redirect: "manual",
    });
    if (res.status >= 200 && res.status < 400) {
      return { ok: true, status: res.status };
    }
    // opaqueredirect (status 0) means a redirect was returned but not followed.
    if (res.type === "opaqueredirect") {
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

export interface FilterReachableOptions {
  timeoutMs?: number;
  onReject?: (url: string, reason: string) => void;
  /** Injectable DNS resolver, forwarded to headCheck. */
  lookup?: DnsLookup;
}

/**
 * Validate a list of URLs in parallel. Returns the subset that passed HEAD check,
 * in the original order. Invalid URLs are logged via the provided logger (or console.warn).
 */
export async function filterReachableUrls(
  urls: string[],
  opts: FilterReachableOptions = {}
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onReject =
    opts.onReject ??
    ((url: string, reason: string) =>
      console.warn(
        JSON.stringify({ severity: "WARNING", message: "url_rejected", url, reason })
      ));

  const results = await Promise.all(urls.map((u) => headCheck(u, timeoutMs, { lookup: opts.lookup })));
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
