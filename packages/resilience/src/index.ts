/**
 * Resilience Primitives — production-grade error recovery
 *
 * - RetryWithBackoff: exponential backoff with jitter
 * - CircuitBreaker: fail-fast when downstream is unhealthy
 * - LRUCache: in-memory cache with TTL for graceful degradation
 *
 * Ported from 実運用SaaS server/lib/resilience.ts (zero product deps).
 */

// ---------------------------------------------------------------------------
// RetryWithBackoff
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of attempts (including the first call). Default: 3 */
  maxRetries: number;
  /** Base delay in ms before the first retry. Default: 1000 */
  baseDelayMs: number;
  /** Maximum delay cap in ms. Default: 30000 */
  maxDelayMs: number;
  /** Jitter factor (0-1). Randomises delay to avoid thundering herd. Default: 0.2 */
  jitter: number;
  /** Optional predicate — only retry if this returns true for the error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each retry. Useful for logging. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.2,
};

export class RetryWithBackoff {
  private opts: RetryOptions;

  constructor(opts?: Partial<RetryOptions>) {
    this.opts = { ...DEFAULT_RETRY, ...opts };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.opts.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (attempt === this.opts.maxRetries) break;

        if (this.opts.shouldRetry && !this.opts.shouldRetry(error, attempt)) {
          break;
        }

        const delayMs = this.calculateDelay(attempt);
        this.opts.onRetry?.(error, attempt, delayMs);
        await sleep(delayMs);
      }
    }

    throw lastError;
  }

  private calculateDelay(attempt: number): number {
    const exponential = this.opts.baseDelayMs * Math.pow(2, attempt - 1);
    const capped = Math.min(exponential, this.opts.maxDelayMs);
    const jitterRange = capped * this.opts.jitter;
    const jitter = (Math.random() * 2 - 1) * jitterRange;
    return Math.max(0, Math.round(capped + jitter));
  }
}

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 5 */
  failureThreshold: number;
  /** How long the circuit stays open before allowing a probe. Default: 60000 (60s) */
  resetTimeoutMs: number;
  /** Called when state changes. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

const DEFAULT_CIRCUIT: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
};

export class CircuitBreaker {
  private opts: CircuitBreakerOptions;
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(opts?: Partial<CircuitBreakerOptions>) {
    this.opts = { ...DEFAULT_CIRCUIT, ...opts };
  }

  getState(): CircuitState {
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.opts.resetTimeoutMs) {
        this.transition("half-open");
      } else {
        throw new CircuitOpenError(
          `Circuit breaker is open. Retry after ${this.opts.resetTimeoutMs}ms.`
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  reset(): void {
    this.consecutiveFailures = 0;
    if (this.state !== "closed") {
      this.transition("closed");
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "half-open") {
      this.transition("closed");
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    if (
      this.consecutiveFailures >= this.opts.failureThreshold &&
      this.state !== "open"
    ) {
      this.transition("open");
    }
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    this.state = to;
    this.opts.onStateChange?.(from, to);
  }
}

export class CircuitOpenError extends Error {
  readonly isCircuitOpen = true;
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

// ---------------------------------------------------------------------------
// LRU Cache with TTL
// ---------------------------------------------------------------------------

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export interface CacheOptions {
  /** Maximum number of entries. Default: 500 */
  maxSize: number;
  /** Time-to-live in ms. Default: 300000 (5 min) */
  ttlMs: number;
}

const DEFAULT_CACHE: CacheOptions = {
  maxSize: 500,
  ttlMs: 300_000,
};

export class LRUCache<V = unknown> {
  private opts: CacheOptions;
  private map: Map<string, CacheEntry<V>> = new Map();

  constructor(opts?: Partial<CacheOptions>) {
    this.opts = { ...DEFAULT_CACHE, ...opts };
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    this.map.delete(key);

    if (this.map.size >= this.opts.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }

    this.map.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.opts.ttlMs),
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  findSimilar(
    predicate: (key: string, value: V) => boolean
  ): { key: string; value: V } | undefined {
    for (const [key, entry] of this.map) {
      if (Date.now() > entry.expiresAt) {
        this.map.delete(key);
        continue;
      }
      if (predicate(key, entry.value)) {
        return { key, value: entry.value };
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
