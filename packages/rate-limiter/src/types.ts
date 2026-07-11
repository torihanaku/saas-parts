/**
 * Public types for @torihanaku/rate-limiter.
 *
 * The client interface is a minimal, structural "Redis-like" contract that
 * covers exactly the commands the limiter issues. Any client that implements
 * these methods (e.g. ioredis) can be injected — no dependency is required.
 */

/** Default tier names. Custom tier maps may use any string keys. */
export type EndpointTier = "essential_read" | "read" | "write" | "auth";

export interface TierConfig {
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

export interface RateLimitStat {
  key: string;
  tier: string;
  requestCount: number;
  limit: number;
  remaining: number;
  violations: number;
  blocked: boolean;
  blockedUntil: string | null;
}

export interface RateLimitStats {
  tiers: Record<string, TierConfig>;
  blocklist: string[];
  allowlist: string[];
  activeEntries: RateLimitStat[];
  totalTrackedKeys: number;
  backend: "redis" | "memory";
}

/**
 * Pipeline/multi contract used by the distributed sliding window.
 * Mirrors ioredis' ChainableCommander for the four commands we chain.
 * `exec()` resolves to an array of [error, result] tuples (or null).
 */
export interface RateLimiterPipeline {
  zremrangebyscore(key: string, min: number | string, max: number | string): RateLimiterPipeline;
  zcard(key: string): RateLimiterPipeline;
  zadd(key: string, score: number, member: string): RateLimiterPipeline;
  pexpire(key: string, milliseconds: number): RateLimiterPipeline;
  exec(): Promise<Array<[unknown, unknown]> | null>;
}

/**
 * Minimal Redis-like client: exactly the commands the limiter calls.
 * ioredis satisfies this interface structurally.
 */
export interface RateLimiterClient {
  get(key: string): Promise<string | null>;
  /** Called as set(key, "1", "PX", ttlMs) — value with millisecond TTL. */
  set(key: string, value: string, px: "PX", milliseconds: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  sismember(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
  multi(): RateLimiterPipeline;
}

/**
 * Path rules used by getEndpointTier(). All lists are empty by default,
 * i.e. no project-specific endpoints are baked in.
 */
export interface EndpointTierRules {
  /** Exact pathnames classified as "auth" (any method). */
  authExactPaths?: string[];
  /** Pathname prefixes classified as "auth" (any method). */
  authPathPrefixes?: string[];
  /** Exact GET pathnames classified as "essential_read". */
  essentialReadExactPaths?: string[];
  /** GET pathname prefixes classified as "essential_read". */
  essentialReadPathPrefixes?: string[];
}

export interface RateLimiterOptions {
  /**
   * Injected Redis-like client. When omitted (or when a call fails),
   * the built-in in-memory fallback is used — preserving the original
   * "Redis with in-memory fallback" behavior.
   */
  client?: RateLimiterClient | null;
  /** Tier definitions. Defaults to DEFAULT_RATE_LIMIT_TIERS. */
  tiers?: Record<string, TierConfig>;
  /** Endpoint classification rules. Empty by default. */
  endpointRules?: EndpointTierRules;
  /**
   * Optional bypass predicate (replaces the original project-specific
   * E2E bypass). Off by default: shouldBypassRateLimit() returns false.
   */
  bypass?: (req: Request) => boolean;
  /** TTL (seconds) for violation counters on the Redis backend. Default 3600. */
  violationTtlSeconds?: number;
  /**
   * Interval for the in-memory fallback cleanup sweep, in ms.
   * Default 60_000 (as in the original). Set to 0 to disable.
   */
  cleanupIntervalMs?: number;
}
