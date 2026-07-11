import { describe, it, expect, afterAll, vi } from "vitest";
import {
  RateLimiter,
  DEFAULT_RATE_LIMIT_TIERS,
  rateLimitHeaders,
  getRateLimitKey,
} from "./index";
import type { RateLimiterClient, RateLimiterPipeline } from "./index";

// Rules mirroring the original project's hardcoded endpoint lists,
// now supplied as configuration.
const projectLikeRules = {
  authExactPaths: ["/api/login"],
  authPathPrefixes: ["/auth/", "/api/sso"],
  essentialReadExactPaths: [
    "/api/user/me",
    "/api/config/features",
    "/api/clients/active",
    "/api/version",
  ],
  essentialReadPathPrefixes: ["/api/notifications/stream"],
};

const limiter = new RateLimiter({ endpointRules: projectLikeRules });
afterAll(() => limiter.dispose());

describe("Rate Limiter", () => {
  describe("getEndpointTier", () => {
    it('classifies configured auth endpoints as "auth"', () => {
      expect(limiter.getEndpointTier("POST", "/api/login")).toBe("auth");
      expect(limiter.getEndpointTier("GET", "/auth/google")).toBe("auth");
      expect(limiter.getEndpointTier("GET", "/api/sso/configurations")).toBe("auth");
    });

    it('classifies write methods as "write"', () => {
      expect(limiter.getEndpointTier("POST", "/api/command")).toBe("write");
      expect(limiter.getEndpointTier("PUT", "/api/team/members/1/role")).toBe("write");
      expect(limiter.getEndpointTier("PATCH", "/api/pipeline/alerts")).toBe("write");
      expect(limiter.getEndpointTier("DELETE", "/api/backlog")).toBe("write");
    });

    it('classifies GET requests as "read"', () => {
      expect(limiter.getEndpointTier("GET", "/api/state")).toBe("read");
      expect(limiter.getEndpointTier("GET", "/api/activity")).toBe("read");
    });

    it('classifies configured hot reads as "essential_read"', () => {
      expect(limiter.getEndpointTier("GET", "/api/user/me")).toBe("essential_read");
      expect(limiter.getEndpointTier("GET", "/api/config/features")).toBe("essential_read");
      expect(limiter.getEndpointTier("GET", "/api/clients/active")).toBe("essential_read");
      expect(limiter.getEndpointTier("GET", "/api/notifications/stream/abc")).toBe("essential_read");
    });

    it("has no special endpoints by default (empty rules)", () => {
      const plain = new RateLimiter({ cleanupIntervalMs: 0 });
      expect(plain.getEndpointTier("POST", "/api/login")).toBe("write");
      expect(plain.getEndpointTier("GET", "/auth/google")).toBe("read");
      expect(plain.getEndpointTier("GET", "/api/user/me")).toBe("read");
    });
  });

  describe("checkRateLimit", () => {
    it("allows requests within limit", async () => {
      const key = "test-allow-" + Date.now();
      const result = await limiter.checkRateLimit(key, "read");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });

    it("blocks after exceeding auth limit (30 requests)", async () => {
      const key = "test-auth-block-" + Date.now();
      let blocked = false;
      for (let i = 0; i < 35; i++) {
        const result = await limiter.checkRateLimit(key, "auth");
        if (!result.allowed) {
          blocked = true;
          expect(result.retryAfter).toBeGreaterThan(0);
          break;
        }
      }
      expect(blocked).toBe(true);
    });

    it("enforces progressive backoff on violations", async () => {
      const key = "test-backoff-" + Date.now();
      // Exhaust the auth limit
      for (let i = 0; i < 30; i++) {
        await limiter.checkRateLimit(key, "auth");
      }
      // First violation
      const first = await limiter.checkRateLimit(key, "auth");
      expect(first.allowed).toBe(false);
      expect(first.retryAfter).toBeDefined();
    });

    it("throws on unknown tier", async () => {
      await expect(limiter.checkRateLimit("k", "nonexistent")).rejects.toThrow(
        /Unknown rate limit tier/,
      );
    });

    it("supports custom tier definitions", async () => {
      const custom = new RateLimiter({
        tiers: { tiny: { maxRequests: 2, windowMs: 60_000 } },
        cleanupIntervalMs: 0,
      });
      const key = "custom-tier-" + Date.now();
      expect((await custom.checkRateLimit(key, "tiny")).allowed).toBe(true);
      expect((await custom.checkRateLimit(key, "tiny")).allowed).toBe(true);
      const third = await custom.checkRateLimit(key, "tiny");
      expect(third.allowed).toBe(false);
      expect(third.limit).toBe(2);
    });
  });

  describe("rateLimitHeaders", () => {
    it("includes standard rate limit headers", () => {
      const headers = rateLimitHeaders({
        allowed: true,
        limit: 200,
        remaining: 150,
        resetAt: Math.ceil(Date.now() / 1000) + 60,
      });
      expect(headers["X-RateLimit-Limit"]).toBe("200");
      expect(headers["X-RateLimit-Remaining"]).toBe("150");
      expect(headers["X-RateLimit-Reset"]).toBeDefined();
    });

    it("includes Retry-After on blocked requests", () => {
      const headers = rateLimitHeaders({
        allowed: false,
        limit: 10,
        remaining: 0,
        resetAt: Math.ceil(Date.now() / 1000) + 60,
        retryAfter: 60,
      });
      expect(headers["Retry-After"]).toBe("60");
    });
  });

  describe("getRateLimitKey", () => {
    it("uses the proxy-appended IP for unauthenticated forwarded requests", () => {
      const req = new Request("http://localhost/api/test", {
        headers: { "x-forwarded-for": "spoofed-client, 1.2.3.4" },
      });
      expect(getRateLimitKey(req)).toBe("1.2.3.4");
    });

    it("uses bearer token hash for authenticated API requests without session cookies", () => {
      const req = new Request("http://localhost/api/test", {
        headers: {
          "x-forwarded-for": "1.2.3.4",
          Authorization: "Bearer token-abc",
        },
      });
      const key = getRateLimitKey(req);
      expect(key).toMatch(/^user:[a-f0-9]{12}$/);
      expect(key).not.toContain("1.2.3.4");
    });

    it("uses session hash (without IP) for authenticated requests", () => {
      const req = new Request("http://localhost/api/test", {
        headers: {
          "x-forwarded-for": "1.2.3.4",
          Cookie: "session=abc123.sig",
        },
      });
      const key = getRateLimitKey(req);
      expect(key).toMatch(/^user:[a-f0-9]{12}$/);
      expect(key).not.toContain("1.2.3.4");
    });
  });

  describe("shouldBypassRateLimit", () => {
    it("never bypasses by default", () => {
      const req = new Request("http://localhost/api/test", {
        headers: { "X-E2E-Bypass": "anything" },
      });
      expect(limiter.shouldBypassRateLimit(req)).toBe(false);
    });

    it("uses the injected bypass predicate when configured", () => {
      const custom = new RateLimiter({
        bypass: (req) => req.headers.get("X-Test-Bypass") === "yes",
        cleanupIntervalMs: 0,
      });
      const yes = new Request("http://localhost/api/test", {
        headers: { "X-Test-Bypass": "yes" },
      });
      const no = new Request("http://localhost/api/test");
      expect(custom.shouldBypassRateLimit(yes)).toBe(true);
      expect(custom.shouldBypassRateLimit(no)).toBe(false);
    });
  });
});

// --- getRateLimitStats, manageIpList, allowlist/blocklist integration ---

describe("getRateLimitStats", () => {
  it("returns correct structure with memory backend", async () => {
    const stats = await limiter.getRateLimitStats();
    expect(stats.backend).toBe("memory");
    expect(stats.tiers).toBeDefined();
    expect(stats.tiers.essential_read).toEqual(DEFAULT_RATE_LIMIT_TIERS.essential_read);
    expect(stats.tiers.read).toEqual(DEFAULT_RATE_LIMIT_TIERS.read);
    expect(stats.tiers.write).toEqual(DEFAULT_RATE_LIMIT_TIERS.write);
    expect(stats.tiers.auth).toEqual(DEFAULT_RATE_LIMIT_TIERS.auth);
    expect(stats.blocklist).toBeInstanceOf(Array);
    expect(stats.allowlist).toBeInstanceOf(Array);
    expect(stats.activeEntries).toBeInstanceOf(Array);
    expect(typeof stats.totalTrackedKeys).toBe("number");
  });

  it("shows correct default tier configs", async () => {
    const stats = await limiter.getRateLimitStats();
    expect(stats.tiers.essential_read?.maxRequests).toBe(1000);
    expect(stats.tiers.essential_read?.windowMs).toBe(60_000);
    expect(stats.tiers.read?.maxRequests).toBe(200);
    expect(stats.tiers.read?.windowMs).toBe(60_000);
    expect(stats.tiers.write?.maxRequests).toBe(50);
    expect(stats.tiers.write?.windowMs).toBe(60_000);
    expect(stats.tiers.auth?.maxRequests).toBe(30);
    expect(stats.tiers.auth?.windowMs).toBe(60_000);
  });
});

describe("manageIpList", () => {
  const uniqueIp = () => `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  it("block action adds to blocklist and removes from allowlist", async () => {
    const ip = uniqueIp();

    // First allowlist the IP
    await limiter.manageIpList("allow", ip);
    const result = await limiter.manageIpList("block", ip);

    expect(result.blocklist).toContain(ip);
    expect(result.allowlist).not.toContain(ip);

    // Clean up
    await limiter.manageIpList("remove", ip);
  });

  it("allow action adds to allowlist and removes from blocklist", async () => {
    const ip = uniqueIp();

    // First blocklist the IP
    await limiter.manageIpList("block", ip);
    const result = await limiter.manageIpList("allow", ip);

    expect(result.allowlist).toContain(ip);
    expect(result.blocklist).not.toContain(ip);

    // Clean up
    await limiter.manageIpList("remove", ip);
  });

  it("remove action removes from both lists", async () => {
    const ip = uniqueIp();

    // Add to blocklist
    await limiter.manageIpList("block", ip);
    let result = await limiter.manageIpList("remove", ip);
    expect(result.blocklist).not.toContain(ip);
    expect(result.allowlist).not.toContain(ip);

    // Add to allowlist
    await limiter.manageIpList("allow", ip);
    result = await limiter.manageIpList("remove", ip);
    expect(result.blocklist).not.toContain(ip);
    expect(result.allowlist).not.toContain(ip);
  });

  it("manageIpList reflects in getRateLimitStats", async () => {
    const ip = uniqueIp();

    await limiter.manageIpList("block", ip);
    let stats = await limiter.getRateLimitStats();
    expect(stats.blocklist).toContain(ip);

    await limiter.manageIpList("remove", ip);
    await limiter.manageIpList("allow", ip);
    stats = await limiter.getRateLimitStats();
    expect(stats.allowlist).toContain(ip);

    // Clean up
    await limiter.manageIpList("remove", ip);
  });
});

describe("allowlist/blocklist integration with checkRateLimit", () => {
  const uniqueIp = () => `integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  it("allowlisted IP always passes checkRateLimit", async () => {
    const ip = uniqueIp();
    await limiter.manageIpList("allow", ip);

    // Even after many requests, allowlisted IP should always pass
    for (let i = 0; i < 50; i++) {
      const result = await limiter.checkRateLimit(ip, "auth"); // auth has lowest limit (30)
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(DEFAULT_RATE_LIMIT_TIERS.auth.maxRequests);
    }

    // Clean up
    await limiter.manageIpList("remove", ip);
  });

  it("blocklisted IP always fails checkRateLimit", async () => {
    const ip = uniqueIp();
    await limiter.manageIpList("block", ip);

    const result = await limiter.checkRateLimit(ip, "read");
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBe(3600);

    // Clean up
    await limiter.manageIpList("remove", ip);
  });

  it("removing from blocklist allows requests again", async () => {
    const ip = uniqueIp();

    // Block, then remove
    await limiter.manageIpList("block", ip);
    const blocked = await limiter.checkRateLimit(ip, "read");
    expect(blocked.allowed).toBe(false);

    await limiter.manageIpList("remove", ip);
    const unblocked = await limiter.checkRateLimit(ip, "read");
    expect(unblocked.allowed).toBe(true);
  });

  it("switching from blocklist to allowlist immediately allows requests", async () => {
    const ip = uniqueIp();

    await limiter.manageIpList("block", ip);
    const blocked = await limiter.checkRateLimit(ip, "read");
    expect(blocked.allowed).toBe(false);

    await limiter.manageIpList("allow", ip);
    const allowed = await limiter.checkRateLimit(ip, "read");
    expect(allowed.allowed).toBe(true);

    // Clean up
    await limiter.manageIpList("remove", ip);
  });
});

// --- Injected client (Redis-like) behavior ---

/** Minimal in-memory fake implementing the RateLimiterClient contract. */
function createFakeClient(): RateLimiterClient & { strings: Map<string, string> } {
  const strings = new Map<string, string>();
  const expiries = new Map<string, number>(); // key → epoch ms
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();

  const isExpired = (key: string) => {
    const at = expiries.get(key);
    if (at !== undefined && Date.now() >= at) {
      strings.delete(key);
      zsets.delete(key);
      expiries.delete(key);
      return true;
    }
    return false;
  };

  const client: RateLimiterClient & { strings: Map<string, string> } = {
    strings,
    async get(key) {
      if (isExpired(key)) return null;
      return strings.get(key) ?? null;
    },
    async set(key, value, _px, milliseconds) {
      strings.set(key, value);
      expiries.set(key, Date.now() + milliseconds);
      return "OK";
    },
    async pttl(key) {
      if (isExpired(key)) return -2;
      const at = expiries.get(key);
      if (at === undefined) return strings.has(key) ? -1 : -2;
      return Math.max(0, at - Date.now());
    },
    async incr(key) {
      const v = Number(strings.get(key) ?? "0") + 1;
      strings.set(key, String(v));
      return v;
    },
    async decr(key) {
      const v = Number(strings.get(key) ?? "0") - 1;
      strings.set(key, String(v));
      return v;
    },
    async expire(key, seconds) {
      expiries.set(key, Date.now() + seconds * 1000);
      return 1;
    },
    async sismember(key, member) {
      return sets.get(key)?.has(member) ? 1 : 0;
    },
    async smembers(key) {
      return [...(sets.get(key) ?? [])];
    },
    async sadd(key, member) {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key)!.add(member);
      return 1;
    },
    async srem(key, member) {
      sets.get(key)?.delete(member);
      return 1;
    },
    async zrem(key, member) {
      zsets.get(key)?.delete(member);
      return 1;
    },
    multi() {
      const ops: Array<() => unknown> = [];
      const pipeline: RateLimiterPipeline = {
        zremrangebyscore(key, _min, max) {
          ops.push(() => {
            const z = zsets.get(key);
            if (!z) return 0;
            let removed = 0;
            for (const [member, score] of z) {
              if (score <= Number(max)) {
                z.delete(member);
                removed++;
              }
            }
            return removed;
          });
          return pipeline;
        },
        zcard(key) {
          ops.push(() => zsets.get(key)?.size ?? 0);
          return pipeline;
        },
        zadd(key, score, member) {
          ops.push(() => {
            if (!zsets.has(key)) zsets.set(key, new Map());
            zsets.get(key)!.set(member, score);
            return 1;
          });
          return pipeline;
        },
        pexpire(key, milliseconds) {
          ops.push(() => {
            expiries.set(key, Date.now() + milliseconds);
            return 1;
          });
          return pipeline;
        },
        async exec() {
          return ops.map((op) => [null, op()] as [unknown, unknown]);
        },
      };
      return pipeline;
    },
  };
  return client;
}

describe("injected client backend", () => {
  it("reports redis backend in stats when a client is injected", async () => {
    const rl = new RateLimiter({ client: createFakeClient(), cleanupIntervalMs: 0 });
    const stats = await rl.getRateLimitStats();
    expect(stats.backend).toBe("redis");
    expect(stats.totalTrackedKeys).toBe(-1); // -1 = unknown when using Redis
  });

  it("enforces limits through the injected client (sorted-set sliding window)", async () => {
    const client = createFakeClient();
    const rl = new RateLimiter({ client, cleanupIntervalMs: 0 });
    const key = "client-" + Date.now();
    let allowedCount = 0;
    let blocked = false;
    for (let i = 0; i < 35; i++) {
      const result = await rl.checkRateLimit(key, "auth");
      if (result.allowed) allowedCount++;
      else {
        blocked = true;
        break;
      }
    }
    expect(allowedCount).toBe(30);
    expect(blocked).toBe(true);
    // Violation counter persisted through the client with expected key format.
    // (Value may be negative: as in the original, the Redis-backed counter is
    // decremented on every well-under-limit request without a floor at 0.)
    expect(client.strings.has(`rl:violations:${key}`)).toBe(true);
  });

  it("manages IP lists through the injected client", async () => {
    const rl = new RateLimiter({ client: createFakeClient(), cleanupIntervalMs: 0 });
    const ip = "9.9.9.9";
    const blockedList = await rl.manageIpList("block", ip);
    expect(blockedList.blocklist).toContain(ip);
    expect((await rl.checkRateLimit(ip, "read")).allowed).toBe(false);

    await rl.manageIpList("allow", ip);
    const result = await rl.checkRateLimit(ip, "read");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(DEFAULT_RATE_LIMIT_TIERS.read.maxRequests);
  });

  it("falls back to in-memory when the injected client fails", async () => {
    const failing = createFakeClient();
    const boom = () => Promise.reject(new Error("connection lost"));
    failing.get = boom;
    failing.sismember = boom;
    failing.incr = boom;
    failing.set = boom;
    failing.multi = () => {
      throw new Error("connection lost");
    };
    const rl = new RateLimiter({ client: failing, cleanupIntervalMs: 0 });
    const key = "fallback-" + Date.now();
    let blocked = false;
    for (let i = 0; i < 35; i++) {
      const result = await rl.checkRateLimit(key, "auth");
      if (!result.allowed) {
        blocked = true;
        break;
      }
    }
    // Limits are still enforced via the built-in in-memory fallback
    expect(blocked).toBe(true);
  });

  it("issues the original Redis command sequence", async () => {
    const client = createFakeClient();
    const sismember = vi.spyOn(client, "sismember");
    const get = vi.spyOn(client, "get");
    const multi = vi.spyOn(client, "multi");
    const rl = new RateLimiter({ client, cleanupIntervalMs: 0 });

    await rl.checkRateLimit("seq-key", "read");

    // allowlist + blocklist membership checks
    expect(sismember).toHaveBeenNthCalledWith(1, "rl:allowlist", "seq-key");
    expect(sismember).toHaveBeenNthCalledWith(2, "rl:blocklist", "seq-key");
    // temporary block check with preserved key format
    expect(get).toHaveBeenCalledWith("rl:block:seq-key");
    // sliding window pipeline
    expect(multi).toHaveBeenCalledTimes(1);
  });
});
