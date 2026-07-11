/**
 * Tests for @torihanaku/usage-quota.
 * Ported from dev-dashboard-v2 tests/usage-limiter.test.ts (enforceUsageLimit)
 * and the quota sections of tests/user-context.test.ts
 * (getPlanLimits / getDailyUsage / trackUsage / checkUsageLimit),
 * adapted to the injected UsageStore + plan-limits config.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  UsageQuota,
  InMemoryUsageStore,
  EXAMPLE_PLAN_LIMITS,
  utcDayStart,
  nextUtcMidnight,
} from "./index.js";
import type { UsageStore } from "./index.js";

function makeQuota(overrides: { store?: UsageStore; now?: () => Date } = {}) {
  const store = overrides.store ?? new InMemoryUsageStore(overrides.now);
  const quota = new UsageQuota({
    store,
    planLimits: EXAMPLE_PLAN_LIMITS,
    now: overrides.now,
  });
  return { store, quota };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =====================================================================
// getPlanLimits / getActionLimit
// =====================================================================

describe("getPlanLimits", () => {
  const { quota } = makeQuota();

  it("returns correct limits for free plan (source PLAN_LIMITS defaults)", () => {
    expect(quota.getPlanLimits("free")).toEqual({
      content_generate: 3,
      intelligence_refresh: 5,
      intelligence_analyze: 1,
      action_suggest: 1,
      daily_dashboard_compose: 1,
      autopilot: 0,
    });
  });

  it("returns correct limits for pro plan", () => {
    expect(quota.getPlanLimits("pro").content_generate).toBe(50);
    expect(quota.getPlanLimits("pro").intelligence_refresh).toBe(100);
    expect(quota.getPlanLimits("pro").autopilot).toBe(50);
  });

  it("returns correct limits for enterprise plan (autopilot unlimited)", () => {
    expect(quota.getPlanLimits("enterprise").content_generate).toBe(200);
    expect(quota.getPlanLimits("enterprise").autopilot).toBe(-1);
  });

  it("falls back to free limits for unknown plan", () => {
    expect(quota.getPlanLimits("unknown-plan")).toEqual(quota.getPlanLimits("free"));
  });

  it("falls back to free limits for empty string", () => {
    expect(quota.getPlanLimits("")).toEqual(quota.getPlanLimits("free"));
  });

  it("falls back to limit 999 for unknown action type", () => {
    expect(quota.getActionLimit("free", "unknown_action")).toBe(999);
  });
});

// =====================================================================
// getDailyUsage (UTC daily window)
// =====================================================================

describe("getDailyUsage", () => {
  it("counts only today's (UTC) events", async () => {
    let clock = new Date("2026-07-10T23:30:00Z");
    const store = new InMemoryUsageStore(() => clock);
    const quota = new UsageQuota({
      store,
      planLimits: EXAMPLE_PLAN_LIMITS,
      now: () => clock,
    });

    // Two events yesterday (UTC)
    await quota.trackUsage("user@test.com", "content_generate");
    await quota.trackUsage("user@test.com", "content_generate");
    expect(await quota.getDailyUsage("user@test.com", "content_generate")).toBe(2);

    // Cross UTC midnight — daily count resets
    clock = new Date("2026-07-11T00:05:00Z");
    expect(await quota.getDailyUsage("user@test.com", "content_generate")).toBe(0);

    await quota.trackUsage("user@test.com", "content_generate");
    expect(await quota.getDailyUsage("user@test.com", "content_generate")).toBe(1);
  });

  it("does not mix users or actions", async () => {
    const { quota } = makeQuota();
    await quota.trackUsage("a@test.com", "content_generate");
    await quota.trackUsage("a@test.com", "intelligence_analyze");
    await quota.trackUsage("b@test.com", "content_generate");
    expect(await quota.getDailyUsage("a@test.com", "content_generate")).toBe(1);
  });

  it("returns 0 on store error", async () => {
    const failing: UsageStore = {
      countSince: vi.fn().mockRejectedValue(new Error("timeout")),
      record: vi.fn(),
    };
    const quota = new UsageQuota({ store: failing, planLimits: EXAMPLE_PLAN_LIMITS });
    expect(await quota.getDailyUsage("user@test.com", "content_generate")).toBe(0);
  });
});

// =====================================================================
// trackUsage
// =====================================================================

describe("trackUsage", () => {
  it("records with correct data", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const store: UsageStore = { countSince: vi.fn().mockResolvedValue(0), record };
    const quota = new UsageQuota({ store, planLimits: EXAMPLE_PLAN_LIMITS });

    await quota.trackUsage("user@test.com", "content_generate", 150);
    expect(record).toHaveBeenCalledWith("user@test.com", "content_generate", 150);
  });

  it("defaults tokensUsed to 0", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const store: UsageStore = { countSince: vi.fn().mockResolvedValue(0), record };
    const quota = new UsageQuota({ store, planLimits: EXAMPLE_PLAN_LIMITS });

    await quota.trackUsage("user@test.com", "intelligence_analyze");
    expect(record).toHaveBeenCalledWith("user@test.com", "intelligence_analyze", 0);
  });

  it("does not throw when the store fails (best-effort)", async () => {
    const store: UsageStore = {
      countSince: vi.fn().mockResolvedValue(0),
      record: vi.fn().mockRejectedValue(new Error("db error")),
    };
    const quota = new UsageQuota({ store, planLimits: EXAMPLE_PLAN_LIMITS });
    await expect(quota.trackUsage("user@test.com", "test_action")).resolves.toBeUndefined();
  });
});

// =====================================================================
// checkUsageLimit
// =====================================================================

describe("checkUsageLimit", () => {
  async function withUsed(count: number) {
    const { quota } = makeQuota();
    for (let i = 0; i < count; i++) {
      await quota.trackUsage("user@test.com", "content_generate");
    }
    return quota;
  }

  it("returns allowed=true when under limit (content_generate, free)", async () => {
    const quota = await withUsed(2);
    const result = await quota.checkUsageLimit("user@test.com", "content_generate", "free");
    expect(result).toEqual({ allowed: true, used: 2, limit: 3 });
  });

  it("returns allowed=false when at limit", async () => {
    const quota = await withUsed(3);
    const result = await quota.checkUsageLimit("user@test.com", "content_generate", "free");
    expect(result).toEqual({ allowed: false, used: 3, limit: 3 });
  });

  it("returns allowed=false when over limit", async () => {
    const quota = await withUsed(10);
    const result = await quota.checkUsageLimit("user@test.com", "content_generate", "free");
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(10);
  });

  it("uses aiAnalysis-equivalent limit for intelligence_analyze (free=1)", async () => {
    const { quota } = makeQuota();
    const result = await quota.checkUsageLimit("user@test.com", "intelligence_analyze", "free");
    expect(result.limit).toBe(1);
    expect(result.allowed).toBe(true);
  });

  it("uses aiAnalysis-equivalent limit for action_suggest (pro=20)", async () => {
    const { quota } = makeQuota();
    const result = await quota.checkUsageLimit("user@test.com", "action_suggest", "pro");
    expect(result.limit).toBe(20);
  });

  it("falls back to limit 999 for unknown action type", async () => {
    const { quota } = makeQuota();
    const result = await quota.checkUsageLimit("user@test.com", "unknown_action", "free");
    expect(result.limit).toBe(999);
    expect(result.allowed).toBe(true);
  });

  it("uses correct limits for pro / enterprise content_generate", async () => {
    const { quota } = makeQuota();
    expect((await quota.checkUsageLimit("u", "content_generate", "pro")).limit).toBe(50);
    expect((await quota.checkUsageLimit("u", "content_generate", "enterprise")).limit).toBe(200);
  });

  it("falls back to free limits for unknown plan", async () => {
    const { quota } = makeQuota();
    const result = await quota.checkUsageLimit("u", "content_generate", "unknown-plan");
    expect(result.limit).toBe(3);
  });

  it("limit -1 means unlimited without counting", async () => {
    const countSince = vi.fn();
    const store: UsageStore = { countSince, record: vi.fn() };
    const quota = new UsageQuota({ store, planLimits: EXAMPLE_PLAN_LIMITS });
    const result = await quota.checkUsageLimit("u", "autopilot", "enterprise");
    expect(result).toEqual({ allowed: true, used: 0, limit: -1 });
    expect(countSince).not.toHaveBeenCalled();
  });

  it("limit 0 blocks the action (free autopilot)", async () => {
    const { quota } = makeQuota();
    const result = await quota.checkUsageLimit("u", "autopilot", "free");
    expect(result).toEqual({ allowed: false, used: 0, limit: 0 });
  });
});

// =====================================================================
// enforceUsageLimit (403 payload + resetAt)
// =====================================================================

describe("enforceUsageLimit", () => {
  it("returns null when user is not authenticated", async () => {
    const { quota } = makeQuota();
    expect(await quota.enforceUsageLimit(null, "content_generate", "free")).toBeNull();
  });

  it("returns null when under limit", async () => {
    const { quota } = makeQuota();
    await quota.trackUsage("user@test.com", "content_generate");
    const result = await quota.enforceUsageLimit("user@test.com", "content_generate", "free");
    expect(result).toBeNull();
  });

  it("returns 403 with the source payload shape when limit exceeded", async () => {
    const { quota } = makeQuota();
    for (let i = 0; i < 3; i++) await quota.trackUsage("user@test.com", "content_generate");

    const result = await quota.enforceUsageLimit("user@test.com", "content_generate", "free");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json();
    expect(body.error).toBe("usage_limit_exceeded");
    expect(body.action).toBe("content_generate");
    expect(body.used).toBe(3);
    expect(body.limit).toBe(3);
    expect(body.plan).toBe("free");
    expect(body.upgradeUrl).toBe("/pricing");
    expect(body.resetAt).toBeDefined();
  });

  it("resetAt is set to next UTC midnight", async () => {
    const clock = () => new Date("2026-07-11T15:04:05Z");
    const { quota } = makeQuota({ now: clock });
    for (let i = 0; i < 3; i++) await quota.trackUsage("user@test.com", "content_generate");

    const result = await quota.enforceUsageLimit("user@test.com", "content_generate", "free");
    const body = await result!.json();
    expect(body.resetAt).toBe("2026-07-12T00:00:00.000Z");
    const resetDate = new Date(body.resetAt);
    expect(resetDate.getUTCHours()).toBe(0);
    expect(resetDate.getUTCMinutes()).toBe(0);
    expect(resetDate.getUTCSeconds()).toBe(0);
  });

  it("honors a custom upgradeUrl", async () => {
    const store = new InMemoryUsageStore();
    const quota = new UsageQuota({
      store,
      planLimits: EXAMPLE_PLAN_LIMITS,
      upgradeUrl: "/billing/upgrade",
    });
    const result = await quota.enforceUsageLimit("u@t.com", "autopilot", "free");
    const body = await result!.json();
    expect(body.upgradeUrl).toBe("/billing/upgrade");
  });
});

// =====================================================================
// UTC helpers
// =====================================================================

describe("UTC helpers", () => {
  it("utcDayStart returns today's UTC midnight", () => {
    expect(utcDayStart(new Date("2026-07-11T15:04:05Z"))).toBe("2026-07-11T00:00:00Z");
  });

  it("nextUtcMidnight rolls over month boundaries", () => {
    expect(nextUtcMidnight(new Date("2026-07-31T23:59:59Z")).toISOString()).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });
});
