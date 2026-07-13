/**
 * Tests for @torihanaku/resilience
 * RetryWithBackoff, CircuitBreaker, LRUCache implementations.
 * Ported from 実運用SaaS tests/resilience.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  RetryWithBackoff,
  CircuitBreaker,
  CircuitOpenError,
  LRUCache,
} from './index'

afterEach(() => {
  vi.useRealTimers()
})

// ─── RetryWithBackoff ─────────────────────────────────────────────────────────

describe('RetryWithBackoff', () => {
  it('returns result immediately when fn succeeds on first attempt', async () => {
    const retry = new RetryWithBackoff({ maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 })
    const fn = vi.fn().mockResolvedValue('success')
    const result = await retry.execute(fn)
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on failure and succeeds on second attempt', async () => {
    const retry = new RetryWithBackoff({ maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 })
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce('recovered')
    const result = await retry.execute(fn)
    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting all retries', async () => {
    const retry = new RetryWithBackoff({ maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 })
    const fn = vi.fn().mockRejectedValue(new Error('always fails'))
    await expect(retry.execute(fn)).rejects.toThrow('always fails')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('calls onRetry callback before each retry', async () => {
    const onRetry = vi.fn()
    const retry = new RetryWithBackoff({
      maxRetries: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: 0,
      onRetry,
    })
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('ok')
    await retry.execute(fn)
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0]?.[1]).toBe(1)  // attempt 1
    expect(onRetry.mock.calls[1]?.[1]).toBe(2)  // attempt 2
  })

  it('respects shouldRetry predicate — stops early when it returns false', async () => {
    const shouldRetry = vi.fn().mockReturnValue(false)
    const retry = new RetryWithBackoff({
      maxRetries: 5,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: 0,
      shouldRetry,
    })
    const fn = vi.fn().mockRejectedValue(new Error('non-retryable'))
    await expect(retry.execute(fn)).rejects.toThrow('non-retryable')
    // Should not retry — shouldRetry returned false
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries when shouldRetry returns true', async () => {
    const shouldRetry = vi.fn().mockReturnValue(true)
    const retry = new RetryWithBackoff({
      maxRetries: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: 0,
      shouldRetry,
    })
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('retryable'))
      .mockResolvedValue('ok')
    await retry.execute(fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('waits with exponential backoff between retries (fake timers)', async () => {
    vi.useFakeTimers()
    const delays: number[] = []
    const retry = new RetryWithBackoff({
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 30_000,
      jitter: 0,
      onRetry: (_err, _attempt, delayMs) => delays.push(delayMs),
    })
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('ok')
    const promise = retry.execute(fn)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBe('ok')
    // 100ms, then 200ms (base * 2^(attempt-1)) — no jitter
    expect(delays).toEqual([100, 200])
  })
})

// ─── CircuitBreaker ───────────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  it('starts in "closed" state', () => {
    const cb = new CircuitBreaker()
    expect(cb.getState()).toBe('closed')
    expect(cb.getConsecutiveFailures()).toBe(0)
  })

  it('executes fn and returns result in closed state', async () => {
    const cb = new CircuitBreaker()
    const result = await cb.execute(() => Promise.resolve(42))
    expect(result).toBe(42)
  })

  it('opens circuit after reaching failure threshold', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 })
    const fn = () => Promise.reject(new Error('fail'))
    // 3 failures to open
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(fn)).rejects.toThrow('fail')
    }
    expect(cb.getState()).toBe('open')
  })

  it('throws CircuitOpenError when circuit is open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 })
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
    // Now circuit is open
    await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toBeInstanceOf(CircuitOpenError)
  })

  it('calls onStateChange when transitioning to open', async () => {
    const onStateChange = vi.fn()
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000, onStateChange })
    const fn = () => Promise.reject(new Error('fail'))
    await expect(cb.execute(fn)).rejects.toThrow()
    await expect(cb.execute(fn)).rejects.toThrow()
    expect(onStateChange).toHaveBeenCalledWith('closed', 'open')
  })

  it('resets to closed state manually', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 })
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
    expect(cb.getState()).toBe('open')
    cb.reset()
    expect(cb.getState()).toBe('closed')
    expect(cb.getConsecutiveFailures()).toBe(0)
  })

  it('transitions from half-open to closed on success', async () => {
    const onStateChange = vi.fn()
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 0,  // immediately allow probing
      onStateChange,
    })
    // Open the circuit
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
    expect(cb.getState()).toBe('open')

    // After resetTimeoutMs=0, next execute() should move to half-open then closed
    const result = await cb.execute(() => Promise.resolve('probe'))
    expect(result).toBe('probe')
    expect(cb.getState()).toBe('closed')
  })

  it('allows a probe after resetTimeoutMs elapses (fake timers)', async () => {
    vi.useFakeTimers()
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 })
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
    expect(cb.getState()).toBe('open')

    // Still within the window → fail fast
    vi.advanceTimersByTime(59_999)
    await expect(cb.execute(() => Promise.resolve('early'))).rejects.toBeInstanceOf(CircuitOpenError)

    // Past the window → half-open probe succeeds and closes the circuit
    vi.advanceTimersByTime(2)
    const result = await cb.execute(() => Promise.resolve('probe'))
    expect(result).toBe('probe')
    expect(cb.getState()).toBe('closed')
  })

  it('re-opens immediately when the half-open probe fails (fake timers)', async () => {
    vi.useFakeTimers()
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 })
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
    vi.advanceTimersByTime(60_001)
    await expect(cb.execute(() => Promise.reject(new Error('probe fails')))).rejects.toThrow('probe fails')
    expect(cb.getState()).toBe('open')
  })
})

describe('CircuitOpenError', () => {
  it('has isCircuitOpen=true and name="CircuitOpenError"', () => {
    const err = new CircuitOpenError('circuit is open')
    expect(err.isCircuitOpen).toBe(true)
    expect(err.name).toBe('CircuitOpenError')
    expect(err.message).toBe('circuit is open')
    expect(err).toBeInstanceOf(Error)
  })
})

// ─── LRUCache ─────────────────────────────────────────────────────────────────

describe('LRUCache', () => {
  it('returns undefined for missing key', () => {
    const cache = new LRUCache<string>()
    expect(cache.get('missing')).toBeUndefined()
  })

  it('stores and retrieves values', () => {
    const cache = new LRUCache<number>()
    cache.set('a', 42)
    expect(cache.get('a')).toBe(42)
  })

  it('returns undefined for expired entries (fake timers)', () => {
    vi.useFakeTimers()
    const cache = new LRUCache<string>({ ttlMs: 1000 })
    cache.set('key', 'value')
    vi.advanceTimersByTime(1001)
    expect(cache.get('key')).toBeUndefined()
  })

  it('evicts oldest entry when maxSize is reached', () => {
    const cache = new LRUCache<number>({ maxSize: 2, ttlMs: 60_000 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)  // should evict 'a'
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })

  it('refreshes recency on get — LRU eviction targets the least recently used', () => {
    const cache = new LRUCache<number>({ maxSize: 2, ttlMs: 60_000 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')      // 'a' becomes most recently used
    cache.set('c', 3)   // should evict 'b', not 'a'
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('c')).toBe(3)
  })

  it('has() returns true for existing non-expired key', () => {
    const cache = new LRUCache<string>({ ttlMs: 60_000 })
    cache.set('key', 'value')
    expect(cache.has('key')).toBe(true)
  })

  it('has() returns false for missing key', () => {
    const cache = new LRUCache<string>()
    expect(cache.has('nonexistent')).toBe(false)
  })

  it('delete() removes an entry', () => {
    const cache = new LRUCache<string>()
    cache.set('key', 'value')
    expect(cache.delete('key')).toBe(true)
    expect(cache.get('key')).toBeUndefined()
  })

  it('clear() removes all entries', () => {
    const cache = new LRUCache<number>()
    cache.set('a', 1)
    cache.set('b', 2)
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('size property returns correct count', () => {
    const cache = new LRUCache<string>()
    expect(cache.size).toBe(0)
    cache.set('a', 'x')
    cache.set('b', 'y')
    expect(cache.size).toBe(2)
  })

  it('findSimilar returns matching entry', () => {
    const cache = new LRUCache<{ score: number }>({ ttlMs: 60_000 })
    cache.set('item-1', { score: 10 })
    cache.set('item-2', { score: 99 })
    const result = cache.findSimilar((_key, val) => val.score > 50)
    expect(result).not.toBeUndefined()
    expect(result!.value.score).toBe(99)
  })

  it('findSimilar returns undefined when no match', () => {
    const cache = new LRUCache<number>({ ttlMs: 60_000 })
    cache.set('a', 5)
    const result = cache.findSimilar((_, val) => val > 100)
    expect(result).toBeUndefined()
  })

  it('supports per-entry custom TTL via set (overrides default)', () => {
    vi.useFakeTimers()
    const cache = new LRUCache<string>({ ttlMs: 1000 })  // 1s default
    cache.set('long', 'value', 60_000)  // 60 second TTL
    vi.advanceTimersByTime(5000)        // past default TTL
    expect(cache.get('long')).toBe('value')  // should still be alive
  })
})
