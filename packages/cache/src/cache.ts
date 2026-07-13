/**
 * Cache layer with Redis support and in-memory fallback.
 * Features: hit/miss stats, pattern invalidation, graceful Redis fallback,
 * distributed sliding-window rate limiting.
 *
 * Ported from 実運用SaaS /cache.ts. The Redis client is now INJECTED
 * (any ioredis-compatible client) instead of being created from env vars —
 * this package never imports ioredis at runtime.
 */

// ─── Injected client contract (structurally compatible with ioredis) ─────────

/** Subset of an ioredis pipeline (multi()) used by the rate limiter. */
export interface RedisPipelineLike {
  zremrangebyscore(key: string, min: number | string, max: number | string): RedisPipelineLike;
  zcard(key: string): RedisPipelineLike;
  zadd(key: string, score: number, member: string): RedisPipelineLike;
  pexpire(key: string, ms: number): RedisPipelineLike;
  exec(): Promise<unknown>;
}

/**
 * Minimal ioredis-compatible client interface (an `ioredis` `Redis` instance
 * satisfies this structurally). Defined locally so this package has no
 * runtime or type dependency on ioredis.
 */
export interface RedisLike {
  status: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: "PX", ttlMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: string, match: "MATCH", pattern: string, count: "COUNT", n: number): Promise<[cursor: string, keys: string[]]>;
  multi(): RedisPipelineLike;
  zrem(key: string, member: string): Promise<number>;
  on?(event: "error", handler: (err: Error) => void): unknown;
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CacheOptions {
  /**
   * ioredis-compatible client instance (already configured/connected by the
   * caller). Omit or pass null to run purely in-memory.
   */
  redis?: RedisLike | null;
  /**
   * Interval for sweeping expired in-memory entries (ms).
   * Pass false to disable the sweeper. Default: 60_000.
   */
  cleanupIntervalMs?: number | false;
}

export interface PrefixStat {
  hits: number;
  misses: number;
  hitRate: string;
}

export interface CacheStats {
  backend: 'redis' | 'memory';
  hits: number;
  misses: number;
  hitRate: string;
  sets: number;
  deletes: number;
  invalidations: number;
  errors: number;
  memoryKeys: number;
  uptime: string;
  startedAt: string;
  prefixBreakdown: Record<string, PrefixStat>;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  resetAt: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class CacheLayer {
  private redis: RedisLike | null;
  private readonly memoryCache = new Map<string, { value: string; expiresAt: number }>();
  private readonly defaultRateLimitFallback = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private readonly stats = {
    hits: 0, misses: 0, sets: 0, deletes: 0, invalidations: 0, errors: 0,
    startedAt: new Date().toISOString(),
    prefixStats: new Map<string, { hits: number; misses: number }>(),
  };

  constructor(options: CacheOptions = {}) {
    this.redis = options.redis ?? null;

    // Same graceful-fallback behaviour as the original module: on a client
    // error we drop to the in-memory path for the rest of the process life.
    if (this.redis?.on) {
      this.redis.on('error', (err) => {
        console.error('[Cache] Redis error, falling back to memory:', err.message);
        this.redis = null;
      });
    }

    const interval = options.cleanupIntervalMs ?? 60_000;
    if (interval !== false) {
      this.cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of this.memoryCache) {
          if (now > entry.expiresAt) this.memoryCache.delete(key);
        }
      }, interval);
      // Do not keep the process alive just for the sweeper (node/bun).
      (this.cleanupTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** Stop the in-memory sweeper timer. */
  dispose(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private extractPrefix(key: string): string {
    const parts = key.split(':');
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : key;
  }

  private recordHit(key: string): void {
    this.stats.hits++;
    const prefix = this.extractPrefix(key);
    const ps = this.stats.prefixStats.get(prefix) || { hits: 0, misses: 0 };
    ps.hits++;
    this.stats.prefixStats.set(prefix, ps);
  }

  private recordMiss(key: string): void {
    this.stats.misses++;
    const prefix = this.extractPrefix(key);
    const ps = this.stats.prefixStats.get(prefix) || { hits: 0, misses: 0 };
    ps.misses++;
    this.stats.prefixStats.set(prefix, ps);
  }

  async cacheGet<T>(key: string): Promise<T | null> {
    try {
      if (this.redis) {
        const val = await this.redis.get(key);
        if (val) { this.recordHit(key); return JSON.parse(val) as T; }
        this.recordMiss(key);
        return null;
      }
      const entry = this.memoryCache.get(key);
      if (!entry) { this.recordMiss(key); return null; }
      if (Date.now() > entry.expiresAt) { this.memoryCache.delete(key); this.recordMiss(key); return null; }
      this.recordHit(key);
      return JSON.parse(entry.value) as T;
    } catch { this.stats.errors++; return null; }
  }

  async cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      this.stats.sets++;
      if (this.redis) { await this.redis.set(key, serialized, 'PX', ttlMs); return; }
      this.memoryCache.set(key, { value: serialized, expiresAt: Date.now() + ttlMs });
    } catch { this.stats.errors++; }
  }

  async cacheDel(key: string): Promise<void> {
    try {
      this.stats.deletes++;
      if (this.redis) { await this.redis.del(key); return; }
      this.memoryCache.delete(key);
    } catch { this.stats.errors++; }
  }

  async cacheInvalidatePrefix(prefix: string): Promise<number> {
    let count = 0;
    try {
      this.stats.invalidations++;
      if (this.redis) {
        let cursor = '0';
        do {
          const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
          cursor = nextCursor;
          if (keys.length > 0) { await this.redis.del(...keys); count += keys.length; }
        } while (cursor !== '0');
        return count;
      }
      for (const key of this.memoryCache.keys()) {
        if (key.startsWith(prefix)) { this.memoryCache.delete(key); count++; }
      }
      return count;
    } catch { this.stats.errors++; return count; }
  }

  isRedisConnected(): boolean {
    return this.redis !== null && this.redis.status === 'ready';
  }

  /**
   * Expose the Redis client for callers that need atomic operations.
   * Returns null when Redis is unavailable — callers must implement a fallback.
   */
  getRedis(): RedisLike | null {
    return this.isRedisConnected() ? this.redis : null;
  }

  /**
   * Distributed sliding window rate limit using Redis sorted sets.
   * Falls back to in-memory Map when Redis is unavailable.
   *
   * Algorithm: ZADD key timestamp uuid → ZREMRANGEBYSCORE (trim expired) →
   * ZCARD (count) → PEXPIRE. All ops run in a pipeline for performance.
   *
   * @param key       Unique key per IP/tier (e.g. "rl:192.0.2.1:read")
   * @param max       Max requests allowed in the window
   * @param windowMs  Window size in milliseconds
   * @param fallbackMap  In-memory fallback map (keyed by `key`).
   *                     Defaults to an instance-internal map.
   * @returns { allowed, count, remaining, resetAt }
   */
  async slidingWindowRateLimit(
    key: string,
    max: number,
    windowMs: number,
    fallbackMap: Map<string, number[]> = this.defaultRateLimitFallback,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const resetAt = Math.ceil((now + windowMs) / 1000);

    const r = this.getRedis();
    if (r) {
      try {
        const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;
        // Pipeline: trim (idx 0) → count-before-add (idx 1) → add (idx 2) → expire (idx 3).
        // The count we gate on is the ZCARD result at index 1, NOT the ZADD
        // result at index 2. ZADD returns the number of *new* members added
        // (always 1 here), so reading index 2 makes `countBefore` a constant 1
        // and the limit never trips for max >= 2 — a fail-open bug.
        const execResult = await r
          .multi()
          .zremrangebyscore(key, '-inf', windowStart)
          .zcard(key)
          .zadd(key, now, member)
          .pexpire(key, windowMs + 1000)
          .exec() as any /* eslint-disable-line @typescript-eslint/no-explicit-any */;

        const countBefore = execResult?.[1]?.[1] ?? 0;
        if (countBefore >= max) {
          // Undo the add — request not allowed
          await r.zrem(key, member);
          return { allowed: false, count: countBefore, remaining: 0, resetAt };
        }
        return { allowed: true, count: countBefore + 1, remaining: max - countBefore - 1, resetAt };
      } catch {
        this.stats.errors++;
        // Fall through to in-memory
      }
    }

    // In-memory fallback (single-instance only)
    const ts = fallbackMap.get(key) ?? [];
    const trimmed = ts.filter(t => t > windowStart);
    if (trimmed.length >= max) {
      fallbackMap.set(key, trimmed);
      return { allowed: false, count: trimmed.length, remaining: 0, resetAt };
    }
    trimmed.push(now);
    fallbackMap.set(key, trimmed);
    return { allowed: true, count: trimmed.length, remaining: max - trimmed.length, resetAt };
  }

  getCacheStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) + '%' : 'N/A';
    const prefixBreakdown: Record<string, PrefixStat> = {};
    for (const [prefix, ps] of this.stats.prefixStats) {
      const t = ps.hits + ps.misses;
      prefixBreakdown[prefix] = { hits: ps.hits, misses: ps.misses, hitRate: t > 0 ? ((ps.hits / t) * 100).toFixed(1) + '%' : 'N/A' };
    }
    const uptimeMin = Math.floor((Date.now() - new Date(this.stats.startedAt).getTime()) / 60_000);
    return {
      backend: this.isRedisConnected() ? 'redis' : 'memory',
      hits: this.stats.hits, misses: this.stats.misses, hitRate,
      sets: this.stats.sets, deletes: this.stats.deletes, invalidations: this.stats.invalidations,
      errors: this.stats.errors, memoryKeys: this.memoryCache.size,
      uptime: `${uptimeMin}m`, startedAt: this.stats.startedAt, prefixBreakdown,
    };
  }
}

/** Factory — `createCache({ redis: new Redis(...) })` or `createCache()` for in-memory only. */
export function createCache(options: CacheOptions = {}): CacheLayer {
  return new CacheLayer(options);
}
