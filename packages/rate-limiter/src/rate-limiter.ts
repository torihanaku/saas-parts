/**
 * Distributed Rate Limiter: Sliding Window + Tiered Limits + IP Blocklist/Allowlist
 *
 * Ported from dev-dashboard-v2 (server/lib/rate-limiter.ts + the sliding-window
 * part of cache.ts). Uses an injected Redis-like client when provided for
 * cross-instance consistency; falls back to in-memory when no client is
 * injected or a client call fails.
 *
 * Redis data model (key formats preserved from the original):
 *   rl:{key}:{tier}         → Sorted set (timestamp → uuid) for sliding window
 *   rl:block:{ip}           → String "1" (with TTL) for temporary blocks
 *   rl:blocklist            → Set of permanently blocked IPs
 *   rl:allowlist            → Set of permanently allowed IPs
 *   rl:violations:{key}     → String count of violations
 */
import { createHash } from "node:crypto";
import type {
  EndpointTier,
  EndpointTierRules,
  RateLimiterClient,
  RateLimiterOptions,
  RateLimitResult,
  RateLimitStats,
  TierConfig,
} from "./types";

export const DEFAULT_RATE_LIMIT_TIERS: Record<EndpointTier, TierConfig> = {
  essential_read: { maxRequests: 1000, windowMs: 60_000 },
  read: { maxRequests: 200, windowMs: 60_000 },
  write: { maxRequests: 50, windowMs: 60_000 },
  auth: { maxRequests: 30, windowMs: 60_000 },
};

// Redis key helpers (formats preserved from the original implementation)
const RL_PREFIX = "rl:";
const BLOCK_PREFIX = "rl:block:";
const BLOCKLIST_KEY = "rl:blocklist";
const ALLOWLIST_KEY = "rl:allowlist";
const VIOL_PREFIX = "rl:violations:";

interface SlidingWindowResult {
  allowed: boolean;
  count: number;
  remaining: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly client: RateLimiterClient | null;
  private readonly tiers: Record<string, TierConfig>;
  private readonly endpointRules: Required<EndpointTierRules>;
  private readonly bypass: (req: Request) => boolean;
  private readonly violationTtlSeconds: number;
  private readonly maxWindowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // In-memory fallback structures (used when no client / client fails)
  private readonly memRateLimitMap = new Map<string, number[]>();
  private readonly memViolations = new Map<string, number>();
  private readonly memBlockedUntil = new Map<string, number>();
  private readonly memBlocklist = new Set<string>();
  private readonly memAllowlist = new Set<string>();

  constructor(options: RateLimiterOptions = {}) {
    this.client = options.client ?? null;
    this.tiers = options.tiers ?? DEFAULT_RATE_LIMIT_TIERS;
    this.endpointRules = {
      authExactPaths: options.endpointRules?.authExactPaths ?? [],
      authPathPrefixes: options.endpointRules?.authPathPrefixes ?? [],
      essentialReadExactPaths: options.endpointRules?.essentialReadExactPaths ?? [],
      essentialReadPathPrefixes: options.endpointRules?.essentialReadPathPrefixes ?? [],
    };
    this.bypass = options.bypass ?? (() => false);
    this.violationTtlSeconds = options.violationTtlSeconds ?? 3600;
    // Cleanup uses the longest configured window (the original hardcoded 60s,
    // which was the longest window in RATE_LIMIT_TIERS).
    this.maxWindowMs = Math.max(
      60_000,
      ...Object.values(this.tiers).map((t) => t.windowMs),
    );

    const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.cleanupMemory(), cleanupIntervalMs);
      // Don't keep the process alive just for the sweep (Node/Bun).
      (this.cleanupTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** Stop the periodic in-memory cleanup timer. */
  dispose(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Classify an endpoint into a tier based on the configured rules.
   * With default (empty) rules: mutating methods → "write", others → "read".
   */
  getEndpointTier(method: string, pathname: string): EndpointTier {
    const r = this.endpointRules;
    if (
      r.authExactPaths.includes(pathname) ||
      r.authPathPrefixes.some((p) => pathname.startsWith(p))
    ) return "auth";
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
      return "write";
    }
    if (
      method === "GET" &&
      (r.essentialReadExactPaths.includes(pathname) ||
        r.essentialReadPathPrefixes.some((p) => pathname.startsWith(p)))
    ) return "essential_read";
    return "read";
  }

  /** Returns true when the configured bypass predicate matches. Off by default. */
  shouldBypassRateLimit(req: Request): boolean {
    return this.bypass(req);
  }

  async checkRateLimit(key: string, tier: string): Promise<RateLimitResult> {
    const now = Date.now();
    const config = this.tiers[tier];
    if (!config) throw new Error(`Unknown rate limit tier: ${tier}`);

    if (await this.isInList(ALLOWLIST_KEY, this.memAllowlist, key)) {
      return {
        allowed: true,
        limit: config.maxRequests,
        remaining: config.maxRequests,
        resetAt: Math.ceil((now + config.windowMs) / 1000),
      };
    }
    if (await this.isInList(BLOCKLIST_KEY, this.memBlocklist, key)) {
      return {
        allowed: false,
        limit: 0,
        remaining: 0,
        resetAt: Math.ceil((now + 3600_000) / 1000),
        retryAfter: 3600,
      };
    }

    if (await this.isBlocked(key)) {
      const blockedUntilMs = await this.getBlockedUntilMs(key);
      const retryAfter = Math.max(1, Math.ceil((blockedUntilMs - now) / 1000));
      return {
        allowed: false,
        limit: config.maxRequests,
        remaining: 0,
        resetAt: Math.ceil(blockedUntilMs / 1000),
        retryAfter,
      };
    }

    const rlKey = `${RL_PREFIX}${key}:${tier}`;
    const result = await this.slidingWindowRateLimit(rlKey, config.maxRequests, config.windowMs);

    if (!result.allowed) {
      const violations = await this.incrViolations(key);
      const backoffMs = Math.min(60_000 * Math.pow(2, violations - 1), 3600_000);
      await this.setBlockedFor(key, backoffMs);
      return {
        allowed: false,
        limit: config.maxRequests,
        remaining: 0,
        resetAt: Math.ceil((now + backoffMs) / 1000),
        retryAfter: Math.ceil(backoffMs / 1000),
      };
    }

    // Recover violations if traffic is well within limits
    if (result.remaining > config.maxRequests * 0.5) {
      await this.decrViolations(key);
    }

    return {
      allowed: true,
      limit: config.maxRequests,
      remaining: result.remaining,
      resetAt: result.resetAt,
    };
  }

  /** Get rate limit stats for admin dashboards. */
  async getRateLimitStats(): Promise<RateLimitStats> {
    const r = this.client;
    const backend: "redis" | "memory" = r ? "redis" : "memory";

    let blocklist: string[] = [];
    let allowlist: string[] = [];

    if (r) {
      try {
        blocklist = await r.smembers(BLOCKLIST_KEY);
        allowlist = await r.smembers(ALLOWLIST_KEY);
      } catch {
        /* fall through */
      }
    } else {
      blocklist = [...this.memBlocklist];
      allowlist = [...this.memAllowlist];
    }

    return {
      tiers: this.tiers,
      blocklist,
      allowlist,
      activeEntries: [], // NOTE: Enumerating per-key stats requires Redis SCAN — omitted for perf
      totalTrackedKeys: r ? -1 : this.memRateLimitMap.size, // -1 = unknown when using Redis
      backend,
    };
  }

  /** Manage IP blocklist/allowlist. */
  async manageIpList(
    action: string,
    ip: string,
  ): Promise<{ blocklist: string[]; allowlist: string[] }> {
    const r = this.client;
    if (r) {
      try {
        if (action === "block") {
          await r.sadd(BLOCKLIST_KEY, ip);
          await r.srem(ALLOWLIST_KEY, ip);
        } else if (action === "allow") {
          await r.sadd(ALLOWLIST_KEY, ip);
          await r.srem(BLOCKLIST_KEY, ip);
        } else if (action === "remove") {
          await r.srem(BLOCKLIST_KEY, ip);
          await r.srem(ALLOWLIST_KEY, ip);
        }
        return {
          blocklist: await r.smembers(BLOCKLIST_KEY),
          allowlist: await r.smembers(ALLOWLIST_KEY),
        };
      } catch {
        /* fall through to memory */
      }
    }
    if (action === "block") {
      this.memBlocklist.add(ip);
      this.memAllowlist.delete(ip);
    } else if (action === "allow") {
      this.memAllowlist.add(ip);
      this.memBlocklist.delete(ip);
    } else if (action === "remove") {
      this.memBlocklist.delete(ip);
      this.memAllowlist.delete(ip);
    }
    return { blocklist: [...this.memBlocklist], allowlist: [...this.memAllowlist] };
  }

  // ---------------------------------------------------------------------
  // Internals (ported 1:1 from the original module-level functions)
  // ---------------------------------------------------------------------

  private async isBlocked(key: string): Promise<boolean> {
    const r = this.client;
    if (r) {
      try {
        const val = await r.get(`${BLOCK_PREFIX}${key}`);
        return val !== null;
      } catch {
        /* fall through */
      }
    }
    const blockedUntil = this.memBlockedUntil.get(key) ?? 0;
    return Date.now() < blockedUntil;
  }

  private async getBlockedUntilMs(key: string): Promise<number> {
    const r = this.client;
    if (r) {
      try {
        const ttl = await r.pttl(`${BLOCK_PREFIX}${key}`);
        if (ttl > 0) return Date.now() + ttl;
      } catch {
        /* fall through */
      }
    }
    return this.memBlockedUntil.get(key) ?? 0;
  }

  private async setBlockedFor(key: string, ms: number): Promise<void> {
    const r = this.client;
    if (r) {
      try {
        await r.set(`${BLOCK_PREFIX}${key}`, "1", "PX", ms);
        return;
      } catch {
        /* fall through */
      }
    }
    this.memBlockedUntil.set(key, Date.now() + ms);
  }

  private async incrViolations(key: string): Promise<number> {
    const r = this.client;
    if (r) {
      try {
        const count = await r.incr(`${VIOL_PREFIX}${key}`);
        await r.expire(`${VIOL_PREFIX}${key}`, this.violationTtlSeconds);
        return count;
      } catch {
        /* fall through */
      }
    }
    const v = (this.memViolations.get(key) ?? 0) + 1;
    this.memViolations.set(key, v);
    return v;
  }

  private async decrViolations(key: string): Promise<void> {
    const r = this.client;
    if (r) {
      try {
        await r.decr(`${VIOL_PREFIX}${key}`);
        return;
      } catch {
        /* fall through */
      }
    }
    const v = this.memViolations.get(key) ?? 0;
    if (v > 0) this.memViolations.set(key, v - 1);
  }

  private async isInList(listKey: string, memSet: Set<string>, ip: string): Promise<boolean> {
    const r = this.client;
    if (r) {
      try {
        return (await r.sismember(listKey, ip)) === 1;
      } catch {
        /* fall through */
      }
    }
    return memSet.has(ip);
  }

  /**
   * Distributed sliding window using sorted sets (ported from cache.ts).
   *
   * Algorithm: ZREMRANGEBYSCORE (trim expired) → ZCARD (count before add) →
   * ZADD → PEXPIRE, all in one pipeline. If the count before the add already
   * reached the max, the added member is removed (ZREM) and the request denied.
   */
  private async slidingWindowRateLimit(
    key: string,
    max: number,
    windowMs: number,
  ): Promise<SlidingWindowResult> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const resetAt = Math.ceil((now + windowMs) / 1000);

    const r = this.client;
    if (r) {
      try {
        const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
        // Pipeline: trim → count before add → add → expire
        const results = await r
          .multi()
          .zremrangebyscore(key, "-inf", windowStart)
          .zcard(key)
          .zadd(key, now, member)
          .pexpire(key, windowMs + 1000)
          .exec();

        const countBefore = Number(results?.[1]?.[1] ?? 0);
        if (countBefore >= max) {
          // Undo the add — request not allowed
          await r.zrem(key, member);
          return { allowed: false, count: countBefore, remaining: 0, resetAt };
        }
        return { allowed: true, count: countBefore + 1, remaining: max - countBefore - 1, resetAt };
      } catch {
        // Fall through to in-memory
      }
    }

    // In-memory fallback (single-instance only)
    const ts = this.memRateLimitMap.get(key) ?? [];
    const trimmed = ts.filter((t) => t > windowStart);
    if (trimmed.length >= max) {
      this.memRateLimitMap.set(key, trimmed);
      return { allowed: false, count: trimmed.length, remaining: 0, resetAt };
    }
    trimmed.push(now);
    this.memRateLimitMap.set(key, trimmed);
    return { allowed: true, count: trimmed.length, remaining: max - trimmed.length, resetAt };
  }

  /** Periodic cleanup of in-memory fallback structures. */
  private cleanupMemory(): void {
    const now = Date.now();
    for (const [key, ts] of this.memRateLimitMap) {
      const trimmed = ts.filter((t) => t > now - this.maxWindowMs);
      if (trimmed.length === 0) this.memRateLimitMap.delete(key);
      else this.memRateLimitMap.set(key, trimmed);
    }
    for (const [key, blockedUntil] of this.memBlockedUntil) {
      if (now > blockedUntil) this.memBlockedUntil.delete(key);
    }
    // Clean up violation counts for keys no longer tracked in rate limit or block maps
    for (const key of this.memViolations.keys()) {
      if (!this.memRateLimitMap.has(key) && !this.memBlockedUntil.has(key)) {
        this.memViolations.delete(key);
      }
    }
  }
}

/** Build the standard X-RateLimit-* / Retry-After headers from a result. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(Math.max(0, result.remaining)),
    "X-RateLimit-Reset": String(result.resetAt),
  };
  if (result.retryAfter) headers["Retry-After"] = String(result.retryAfter);
  return headers;
}

/**
 * Derive the rate-limit key from a request: hashed bearer token or session
 * cookie for authenticated requests, otherwise the proxy-appended client IP.
 */
export function getRateLimitKey(req: Request): string {
  const xForwardedFor = req.headers.get("x-forwarded-for") || "";
  const forwardedIps = xForwardedFor.split(",").map((ip) => ip.trim()).filter(Boolean);
  const ip =
    forwardedIps[forwardedIps.length - 1] ||
    req.headers.get("cf-connecting-ip")?.trim() ||
    "unknown";
  const authorization = req.headers.get("Authorization") || "";
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  const bearerToken = bearerMatch?.[1];
  if (bearerToken) {
    const hash = createHash("sha256").update(bearerToken).digest("hex");
    return `user:${hash.substring(0, 12)}`;
  }
  const cookie = req.headers.get("Cookie") || "";
  const sessionMatch = cookie.match(/session=([^;]+)/);
  const sessionValue = sessionMatch?.[1];
  if (sessionValue) {
    const hash = createHash("sha256").update(sessionValue).digest("hex");
    return `user:${hash.substring(0, 12)}`;
  }
  return ip;
}
