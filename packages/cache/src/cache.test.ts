/**
 * Ported from 実運用SaaS tests/cache.test.ts.
 * Adapted: the module-level singleton (env-driven Redis) became an injected
 * client via createCache(); vi.mock('ioredis') became a plain mock object.
 * Product-specific CACHE_TTL / CACHE_KEYS constants were removed with the port.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createCache, type CacheLayer, type RedisLike } from './index'

// ---------- in-memory instance under test ----------

const cache: CacheLayer = createCache()

afterAll(() => {
  cache.dispose()
})

beforeEach(() => {
  vi.clearAllMocks()
})

// =====================================================================
// isRedisConnected / getRedis (in-memory mode — no client injected)
// =====================================================================

describe('isRedisConnected', () => {
  it('returns false when Redis is not configured', () => {
    expect(cache.isRedisConnected()).toBe(false)
  })
})

describe('getRedis', () => {
  it('returns null when Redis is not connected', () => {
    expect(cache.getRedis()).toBeNull()
  })
})

// =====================================================================
// cacheGet (in-memory)
// =====================================================================

describe('cacheGet (memory)', () => {
  it('returns null for a missing key', async () => {
    const result = await cache.cacheGet('nonexistent:key')
    expect(result).toBeNull()
  })

  it('returns the cached value after cacheSet', async () => {
    await cache.cacheSet('test:get:hit', { data: 'hello' }, 60_000)
    const result = await cache.cacheGet<{ data: string }>('test:get:hit')
    expect(result).toEqual({ data: 'hello' })
  })

  it('returns null for expired entries', async () => {
    // Set with 1ms TTL and wait for expiration
    await cache.cacheSet('test:get:expired', { data: 'gone' }, 1)
    // Allow the TTL to pass
    await new Promise(resolve => setTimeout(resolve, 10))
    const result = await cache.cacheGet('test:get:expired')
    expect(result).toBeNull()
  })

  it('returns complex nested objects', async () => {
    const complex = { nested: { arr: [1, 2, 3], flag: true, label: 'test' } }
    await cache.cacheSet('test:get:complex', complex, 60_000)
    const result = await cache.cacheGet<typeof complex>('test:get:complex')
    expect(result).toEqual(complex)
  })

  it('returns numeric values correctly', async () => {
    await cache.cacheSet('test:get:num', 42, 60_000)
    const result = await cache.cacheGet<number>('test:get:num')
    expect(result).toBe(42)
  })

  it('returns string values correctly', async () => {
    await cache.cacheSet('test:get:str', 'hello world', 60_000)
    const result = await cache.cacheGet<string>('test:get:str')
    expect(result).toBe('hello world')
  })
})

// =====================================================================
// cacheSet (in-memory)
// =====================================================================

describe('cacheSet (memory)', () => {
  it('stores a value that can be retrieved', async () => {
    await cache.cacheSet('test:set:basic', { count: 1 }, 60_000)
    const result = await cache.cacheGet<{ count: number }>('test:set:basic')
    expect(result).toEqual({ count: 1 })
  })

  it('overwrites existing value', async () => {
    await cache.cacheSet('test:set:overwrite', 'v1', 60_000)
    await cache.cacheSet('test:set:overwrite', 'v2', 60_000)
    const result = await cache.cacheGet<string>('test:set:overwrite')
    expect(result).toBe('v2')
  })

  it('increments the sets counter in stats', async () => {
    const before = cache.getCacheStats().sets
    await cache.cacheSet('test:set:stats', 'val', 60_000)
    const after = cache.getCacheStats().sets
    expect(after).toBe(before + 1)
  })
})

// =====================================================================
// cacheDel (in-memory)
// =====================================================================

describe('cacheDel (memory)', () => {
  it('deletes a cached entry', async () => {
    await cache.cacheSet('test:del:target', 'value', 60_000)
    await cache.cacheDel('test:del:target')
    const result = await cache.cacheGet('test:del:target')
    expect(result).toBeNull()
  })

  it('does not throw when deleting non-existent key', async () => {
    await expect(cache.cacheDel('test:del:nonexistent')).resolves.toBeUndefined()
  })

  it('increments the deletes counter', async () => {
    const before = cache.getCacheStats().deletes
    await cache.cacheDel('test:del:counter')
    const after = cache.getCacheStats().deletes
    expect(after).toBe(before + 1)
  })
})

// =====================================================================
// cacheInvalidatePrefix (in-memory)
// =====================================================================

describe('cacheInvalidatePrefix (memory)', () => {
  it('removes all keys with matching prefix', async () => {
    await cache.cacheSet('prefix:a:1', 'v1', 60_000)
    await cache.cacheSet('prefix:a:2', 'v2', 60_000)
    await cache.cacheSet('prefix:b:1', 'v3', 60_000)

    const count = await cache.cacheInvalidatePrefix('prefix:a')
    expect(count).toBe(2)
    expect(await cache.cacheGet('prefix:a:1')).toBeNull()
    expect(await cache.cacheGet('prefix:a:2')).toBeNull()
    expect(await cache.cacheGet('prefix:b:1')).toEqual('v3')
  })

  it('returns 0 when no keys match', async () => {
    const count = await cache.cacheInvalidatePrefix('no:match:prefix')
    expect(count).toBe(0)
  })

  it('increments the invalidations counter', async () => {
    const before = cache.getCacheStats().invalidations
    await cache.cacheInvalidatePrefix('test:invalidate')
    const after = cache.getCacheStats().invalidations
    expect(after).toBe(before + 1)
  })
})

// =====================================================================
// slidingWindowRateLimit (in-memory fallback)
// =====================================================================

describe('slidingWindowRateLimit (memory)', () => {
  it('allows requests under the limit', async () => {
    const fallbackMap = new Map<string, number[]>()
    const result = await cache.slidingWindowRateLimit('rl:test:allow', 5, 60_000, fallbackMap)
    expect(result.allowed).toBe(true)
    expect(result.count).toBe(1)
    expect(result.remaining).toBe(4)
  })

  it('blocks requests at the limit', async () => {
    const fallbackMap = new Map<string, number[]>()
    const max = 3
    // Fill up to the limit
    for (let i = 0; i < max; i++) {
      await cache.slidingWindowRateLimit('rl:test:block', max, 60_000, fallbackMap)
    }
    // Next request should be blocked
    const result = await cache.slidingWindowRateLimit('rl:test:block', max, 60_000, fallbackMap)
    expect(result.allowed).toBe(false)
    expect(result.count).toBe(max)
    expect(result.remaining).toBe(0)
  })

  it('allows requests after window expires', async () => {
    const fallbackMap = new Map<string, number[]>()
    const windowMs = 50 // very short window

    // Fill up
    await cache.slidingWindowRateLimit('rl:test:expire', 1, windowMs, fallbackMap)

    // Wait for window to pass
    await new Promise(resolve => setTimeout(resolve, 60))

    // Should be allowed again
    const result = await cache.slidingWindowRateLimit('rl:test:expire', 1, windowMs, fallbackMap)
    expect(result.allowed).toBe(true)
  })

  it('returns resetAt as a future epoch in seconds', async () => {
    const fallbackMap = new Map<string, number[]>()
    const now = Math.ceil(Date.now() / 1000)
    const result = await cache.slidingWindowRateLimit('rl:test:reset', 10, 60_000, fallbackMap)
    expect(result.resetAt).toBeGreaterThanOrEqual(now)
  })

  it('tracks different keys independently', async () => {
    const fallbackMap = new Map<string, number[]>()
    await cache.slidingWindowRateLimit('rl:key:a', 1, 60_000, fallbackMap)
    // key:a is now full, but key:b should still be allowed
    const result = await cache.slidingWindowRateLimit('rl:key:b', 1, 60_000, fallbackMap)
    expect(result.allowed).toBe(true)
  })

  it('trims expired timestamps from the fallback map', async () => {
    const fallbackMap = new Map<string, number[]>()
    // Add an old timestamp manually (simulate expired entry)
    const oldTimestamp = Date.now() - 120_000 // 2 minutes ago
    fallbackMap.set('rl:test:trim', [oldTimestamp])

    // With a 60s window, the old timestamp should be trimmed
    const result = await cache.slidingWindowRateLimit('rl:test:trim', 2, 60_000, fallbackMap)
    expect(result.allowed).toBe(true)
    expect(result.count).toBe(1) // only the new one, old one trimmed
  })

  it('uses an instance-internal fallback map when none is provided', async () => {
    const local = createCache({ cleanupIntervalMs: false })
    await local.slidingWindowRateLimit('rl:internal:map', 1, 60_000)
    const result = await local.slidingWindowRateLimit('rl:internal:map', 1, 60_000)
    expect(result.allowed).toBe(false)
  })
})

// =====================================================================
// getCacheStats
// =====================================================================

describe('getCacheStats', () => {
  it('returns expected structure', () => {
    const stats = cache.getCacheStats()
    expect(stats).toHaveProperty('backend')
    expect(stats).toHaveProperty('hits')
    expect(stats).toHaveProperty('misses')
    expect(stats).toHaveProperty('hitRate')
    expect(stats).toHaveProperty('sets')
    expect(stats).toHaveProperty('deletes')
    expect(stats).toHaveProperty('invalidations')
    expect(stats).toHaveProperty('errors')
    expect(stats).toHaveProperty('memoryKeys')
    expect(stats).toHaveProperty('uptime')
    expect(stats).toHaveProperty('startedAt')
    expect(stats).toHaveProperty('prefixBreakdown')
  })

  it('reports memory backend when Redis is not connected', () => {
    expect(cache.getCacheStats().backend).toBe('memory')
  })

  it('tracks hit rate correctly', async () => {
    // Record some hits and misses
    await cache.cacheSet('stats:test:hit', 'val', 60_000)
    await cache.cacheGet('stats:test:hit') // hit
    await cache.cacheGet('stats:test:miss') // miss

    const stats = cache.getCacheStats()
    expect(stats.hits).toBeGreaterThanOrEqual(1)
    expect(stats.misses).toBeGreaterThanOrEqual(1)
    // hitRate should be a string with '%'
    expect(stats.hitRate).toContain('%')
  })

  it('reports memoryKeys count', async () => {
    const keysBefore = cache.getCacheStats().memoryKeys
    await cache.cacheSet('stats:test:count', 'val', 60_000)
    const keysAfter = cache.getCacheStats().memoryKeys
    expect(keysAfter).toBeGreaterThanOrEqual(keysBefore)
  })

  it('includes prefix breakdown', async () => {
    await cache.cacheSet('breakdown:test:key', 'val', 60_000)
    await cache.cacheGet('breakdown:test:key')
    const stats = cache.getCacheStats()
    expect(stats.prefixBreakdown).toBeDefined()
    expect(typeof stats.prefixBreakdown).toBe('object')
  })

  it('uptime is a string ending with m', () => {
    const stats = cache.getCacheStats()
    expect(stats.uptime).toMatch(/^\d+m$/)
  })

  it('startedAt is a valid ISO string', () => {
    const stats = cache.getCacheStats()
    const parsed = new Date(stats.startedAt)
    expect(parsed.getTime()).not.toBeNaN()
  })
})

// =====================================================================
// Integration-style: full cache lifecycle
// =====================================================================

describe('cache lifecycle (memory)', () => {
  it('set → get → delete → get returns null', async () => {
    const key = 'lifecycle:test'
    await cache.cacheSet(key, { step: 1 }, 60_000)
    expect(await cache.cacheGet(key)).toEqual({ step: 1 })
    await cache.cacheDel(key)
    expect(await cache.cacheGet(key)).toBeNull()
  })

  it('set → invalidatePrefix → get returns null', async () => {
    await cache.cacheSet('lifecycle:inv:a', 'a', 60_000)
    await cache.cacheSet('lifecycle:inv:b', 'b', 60_000)
    const count = await cache.cacheInvalidatePrefix('lifecycle:inv')
    expect(count).toBe(2)
    expect(await cache.cacheGet('lifecycle:inv:a')).toBeNull()
    expect(await cache.cacheGet('lifecycle:inv:b')).toBeNull()
  })
})

// =====================================================================
// Redis code path tests (injected mock client instead of vi.mock('ioredis'))
// =====================================================================

function makeRedisMock() {
  return {
    status: 'ready',
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    scan: vi.fn().mockResolvedValue(['0', []]),
    multi: vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      pexpire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([[null, 0], [null, 0], [null, 1], [null, 1]]),
    })),
    zrem: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
  }
}

describe('Redis code path', () => {
  let redisMock: ReturnType<typeof makeRedisMock>
  let redisCache: CacheLayer

  beforeEach(() => {
    redisMock = makeRedisMock()
    redisCache = createCache({ redis: redisMock as unknown as RedisLike, cleanupIntervalMs: false })
  })

  it('registers an error handler on the injected client', () => {
    expect(redisMock.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('cacheGet returns null on Redis miss', async () => {
    // The mock Redis.get returns null by default, so this will be a miss
    const result = await redisCache.cacheGet('redis:test:key')
    expect(result).toBeNull()
    expect(redisMock.get).toHaveBeenCalledWith('redis:test:key')
  })

  it('cacheGet returns parsed value on Redis hit', async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({ from: 'redis' }))
    const result = await redisCache.cacheGet<{ from: string }>('redis:test:hit')
    expect(result).toEqual({ from: 'redis' })
  })

  it('cacheSet calls Redis set with PX ttl', async () => {
    await redisCache.cacheSet('redis:test:set', { data: 1 }, 5000)
    expect(redisMock.set).toHaveBeenCalledWith('redis:test:set', JSON.stringify({ data: 1 }), 'PX', 5000)
  })

  it('cacheDel calls Redis del', async () => {
    await redisCache.cacheDel('redis:test:del')
    expect(redisMock.del).toHaveBeenCalledWith('redis:test:del')
  })

  it('cacheInvalidatePrefix scans and deletes via Redis', async () => {
    const count = await redisCache.cacheInvalidatePrefix('redis:prefix')
    // Mock scan returns ['0', []] so count = 0
    expect(count).toBe(0)
    expect(redisMock.scan).toHaveBeenCalledWith('0', 'MATCH', 'redis:prefix*', 'COUNT', 100)
  })

  it('isRedisConnected returns true when Redis mock is ready', () => {
    expect(redisCache.isRedisConnected()).toBe(true)
  })

  it('getRedis returns the Redis instance when connected', () => {
    const r = redisCache.getRedis()
    expect(r).not.toBeNull()
  })

  it('getCacheStats reports redis backend', () => {
    const stats = redisCache.getCacheStats()
    expect(stats.backend).toBe('redis')
  })

  it('slidingWindowRateLimit uses Redis pipeline', async () => {
    const fallbackMap = new Map<string, number[]>()
    const result = await redisCache.slidingWindowRateLimit('rl:redis:test', 10, 60_000, fallbackMap)
    // Mock exec returns [[null, 0], [null, 0], [null, 1], [null, 1]]
    //   index 0 = ZREMRANGEBYSCORE, index 1 = ZCARD (count before add) = 0,
    //   index 2 = ZADD, index 3 = PEXPIRE.
    // We gate on the ZCARD result at index 1 = 0, so:
    // countBefore = 0, count = 0 + 1 = 1, remaining = 10 - 0 - 1 = 9.
    expect(result.allowed).toBe(true)
    expect(result.count).toBe(1)
    expect(result.remaining).toBe(9)
  })

  it('enforces the limit on the Redis path (regression: reads ZCARD, not ZADD)', async () => {
    // A faithful sorted-set mock: exec() returns REAL pipeline results in order
    // [ZREMRANGEBYSCORE, ZCARD, ZADD, PEXPIRE]. ZADD always returns 1 (one new
    // member), so a limiter that reads index 2 would be stuck at countBefore=1
    // and never block for max>=2 — this test proves it actually blocks.
    const zset: { score: number; member: string }[] = []
    const realRedis = {
      status: 'ready',
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      del: vi.fn().mockResolvedValue(0),
      scan: vi.fn().mockResolvedValue(['0', []]),
      multi: vi.fn(() => {
        const ops: Array<() => [null, number]> = []
        const pipe: any = {
          zremrangebyscore: (_k: string, _min: unknown, max: unknown) => {
            ops.push(() => {
              const before = zset.length
              for (let i = zset.length - 1; i >= 0; i--) if (zset[i]!.score <= Number(max)) zset.splice(i, 1)
              return [null, before - zset.length]
            })
            return pipe
          },
          zcard: () => { ops.push(() => [null, zset.length]); return pipe },
          zadd: (_k: string, score: number, member: string) => {
            ops.push(() => { zset.push({ score, member }); return [null, 1] })
            return pipe
          },
          pexpire: () => { ops.push(() => [null, 1]); return pipe },
          exec: async () => ops.map((fn) => fn()),
        }
        return pipe
      }),
      zrem: vi.fn((_k: string, member: string) => {
        const before = zset.length
        for (let i = zset.length - 1; i >= 0; i--) if (zset[i]!.member === member) zset.splice(i, 1)
        return Promise.resolve(before - zset.length)
      }),
      on: vi.fn(),
    }
    const rl = createCache({ redis: realRedis as unknown as RedisLike, cleanupIntervalMs: false })
    const key = 'rl:regression:redis'
    const max = 3
    const outcomes: boolean[] = []
    for (let i = 0; i < 5; i++) {
      outcomes.push((await rl.slidingWindowRateLimit(key, max, 60_000)).allowed)
    }
    // First 3 allowed, the rest blocked.
    expect(outcomes).toEqual([true, true, true, false, false])
    // Blocked requests must not accumulate in the sorted set (zrem undo works).
    expect(zset.length).toBe(max)
  })

  it('falls back to memory after the client emits an error', async () => {
    const errorHandler = redisMock.on.mock.calls.find((c) => c[0] === 'error')?.[1] as (err: Error) => void
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    errorHandler(new Error('connection lost'))
    errSpy.mockRestore()

    expect(redisCache.isRedisConnected()).toBe(false)
    // Subsequent ops use the in-memory path (Redis mock untouched)
    await redisCache.cacheSet('fallback:key', 'v', 60_000)
    expect(redisMock.set).not.toHaveBeenCalled()
    expect(await redisCache.cacheGet('fallback:key')).toBe('v')
  })
})
