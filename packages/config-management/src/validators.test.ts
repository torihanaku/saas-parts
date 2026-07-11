/**
 * Tests for validators.ts — ported from dev-dashboard-v2 tests/config-validator.test.ts.
 * env モックの代わりにバリデータ設定オブジェクトを組み立てて注入する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createBuiltinValidators,
  createHealthCheckRunner,
  type BuiltinValidatorsConfig,
  type HealthCheckRunner,
} from "./validators";

let fetchSpy: ReturnType<typeof vi.spyOn>;
let redisConnected = false;

function buildRunner(overrides: Partial<BuiltinValidatorsConfig> = {}): HealthCheckRunner {
  const config: BuiltinValidatorsConfig = {
    supabase: { url: "https://test.supabase.co", serviceRoleKey: "test-key" },
    redis: { host: undefined, isConnected: () => redisConnected },
    ...overrides,
  };
  return createHealthCheckRunner(createBuiltinValidators(config));
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
  vi.clearAllMocks();
  redisConnected = false;
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("runAll", () => {
  it("returns an array of health check results", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(null, { status: 200 })));
    const results = await buildRunner().runAll();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns skipped status for unconfigured services", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(null, { status: 200 })));
    const results = await buildRunner().runAll();
    // Anthropic, GitHub, Slack, Stripe, Resend, OpenAI are all unconfigured
    const skipped = results.filter(r => r.status === "skipped");
    expect(skipped.length).toBeGreaterThan(0);
  });

  it("returns skipped for redis when host is empty", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(null, { status: 200 })));
    const results = await buildRunner().runAll();
    const redisCheck = results.find(r => r.service === "redis");
    expect(redisCheck?.status).toBe("skipped");
  });

  it("returns each result with service and category fields", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(null, { status: 200 })));
    const results = await buildRunner().runAll();
    for (const r of results) {
      expect(typeof r.service).toBe("string");
      expect(typeof r.category).toBe("string");
      expect(["ok", "error", "skipped"]).toContain(r.status);
    }
  });
});

describe("run (single service)", () => {
  it("returns null for unknown service name", async () => {
    const result = await buildRunner().run("nonexistent-service");
    expect(result).toBeNull();
  });

  it('returns HealthCheck for known service "redis" (no Redis configured)', async () => {
    const result = await buildRunner().run("redis");
    expect(result).not.toBeNull();
    expect(result!.service).toBe("redis");
    expect(result!.status).toBe("skipped");
  });

  it("returns skipped for anthropic when not configured", async () => {
    const result = await buildRunner().run("anthropic");
    expect(result).not.toBeNull();
    expect(result!.service).toBe("anthropic");
    expect(result!.status).toBe("skipped");
  });

  it("returns skipped for github when not configured", async () => {
    const result = await buildRunner().run("github");
    expect(result!.status).toBe("skipped");
  });

  it("returns skipped for slack when not configured", async () => {
    const result = await buildRunner().run("slack");
    expect(result!.status).toBe("skipped");
  });

  it("returns skipped for stripe when not configured", async () => {
    const result = await buildRunner().run("stripe");
    expect(result!.status).toBe("skipped");
  });

  it("returns skipped for resend when not configured", async () => {
    const result = await buildRunner().run("resend");
    expect(result!.status).toBe("skipped");
  });

  it("returns skipped for openai when not configured", async () => {
    const result = await buildRunner().run("openai");
    expect(result!.status).toBe("skipped");
  });

  it("returns check for supabase (configured)", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(null, { status: 200 })));
    const result = await buildRunner().run("supabase");
    expect(result).not.toBeNull();
    expect(result!.service).toBe("supabase");
  });

  it("returns error for supabase when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));
    const result = await buildRunner().run("supabase");
    expect(result!.status).toBe("error");
    expect(result!.message).toContain("network error");
  });

  it("returns ok for supabase when fetch returns 406", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(null, { status: 406 })));
    const result = await buildRunner().run("supabase");
    expect(result!.status).toBe("ok");
  });

  it("returns error for supabase when fetch returns 500", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(null, { status: 500 })));
    const result = await buildRunner().run("supabase");
    expect(result!.status).toBe("error");
    expect(result!.message).toContain("500");
  });
});

describe("run — configured optional services", () => {
  it("returns ok for anthropic when key set and /v1/models succeeds", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response('{"data":[]}', { status: 200 })));
    const result = await buildRunner({ anthropic: { apiKey: "sk-ant-test" } }).run("anthropic");
    expect(result!.service).toBe("anthropic");
    expect(result!.status).toBe("ok");
  });

  it("returns error for anthropic when /v1/models returns 401", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response("Unauthorized", { status: 401 })));
    const result = await buildRunner({ anthropic: { apiKey: "sk-ant-invalid" } }).run("anthropic");
    expect(result!.status).toBe("error");
    expect(result!.message).toContain("401");
  });

  it("returns error for anthropic when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));
    const result = await buildRunner({ anthropic: { apiKey: "sk-ant-test" } }).run("anthropic");
    expect(result!.status).toBe("error");
  });

  it("returns ok for github when token set and fetch succeeds", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    const result = await buildRunner({ github: { token: "ghp_test" } }).run("github");
    expect(result!.service).toBe("github");
    expect(result!.status).toBe("ok");
  });

  it("returns error for github when fetch returns 401", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response("Unauthorized", { status: 401 })));
    const result = await buildRunner({ github: { token: "bad-token" } }).run("github");
    expect(result!.status).toBe("error");
  });

  it("returns error for github when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("connection refused"));
    const result = await buildRunner({ github: { token: "ghp_test" } }).run("github");
    expect(result!.status).toBe("error");
  });

  it("returns ok for slack when both clientId and botToken set", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const result = await buildRunner({ slack: { botToken: "xoxb-test", clientId: "client-id" } }).run("slack");
    expect(result!.service).toBe("slack");
    expect(result!.status).toBe("ok");
  });

  it("returns ok for slack (OAuth mode) when only clientId is set", async () => {
    const result = await buildRunner({ slack: { clientId: "client-id" } }).run("slack");
    expect(result!.service).toBe("slack");
    expect(result!.status).toBe("ok");
    expect(result!.message).toContain("OAuth configured");
  });

  it("returns error for slack when auth.test returns ok=false", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 })));
    const result = await buildRunner({ slack: { botToken: "xoxb-test", clientId: "client-id" } }).run("slack");
    expect(result!.status).toBe("error");
    expect(result!.message).toBe("invalid_auth");
  });

  it("returns error for slack when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));
    const result = await buildRunner({ slack: { botToken: "xoxb-test", clientId: "client-id" } }).run("slack");
    expect(result!.status).toBe("error");
  });

  it("returns ok for stripe when key set and fetch succeeds", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    const result = await buildRunner({ stripe: { secretKey: "sk_test_xxx" } }).run("stripe");
    expect(result!.service).toBe("stripe");
    expect(result!.status).toBe("ok");
  });

  it("returns error for stripe when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("timeout"));
    const result = await buildRunner({ stripe: { secretKey: "sk_test_xxx" } }).run("stripe");
    expect(result!.status).toBe("error");
  });

  it("returns ok for resend when key set and fetch succeeds", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    const result = await buildRunner({ resend: { apiKey: "re_test_key" } }).run("resend");
    expect(result!.service).toBe("resend");
    expect(result!.status).toBe("ok");
  });

  it("returns error for resend when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("timeout"));
    const result = await buildRunner({ resend: { apiKey: "re_test_key" } }).run("resend");
    expect(result!.status).toBe("error");
  });

  it("returns ok for openai when key set and fetch succeeds", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    const result = await buildRunner({ openai: { apiKey: "sk-test" } }).run("openai");
    expect(result!.service).toBe("openai");
    expect(result!.status).toBe("ok");
  });

  it("returns error for openai when fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("timeout"));
    const result = await buildRunner({ openai: { apiKey: "sk-test" } }).run("openai");
    expect(result!.status).toBe("error");
  });

  it("returns ok for redis when host set and isConnected returns true", async () => {
    redisConnected = true;
    const result = await buildRunner({ redis: { host: "localhost", isConnected: () => redisConnected } }).run("redis");
    expect(result!.service).toBe("redis");
    expect(result!.status).toBe("ok");
  });

  it("returns error for redis when host set but isConnected returns false", async () => {
    redisConnected = false;
    const result = await buildRunner({ redis: { host: "localhost", isConnected: () => redisConnected } }).run("redis");
    expect(result!.service).toBe("redis");
    expect(result!.status).toBe("error");
    expect(result!.message).toContain("not connected");
  });
});

describe("pluggable registry", () => {
  it("supports registering custom validators", async () => {
    const runner = buildRunner();
    runner.register("my-service", () => ({ service: "my-service", category: "custom", status: "ok" }));
    const result = await runner.run("my-service");
    expect(result!.status).toBe("ok");
    const all = await runner.runAll();
    expect(all.some(r => r.service === "my-service")).toBe(true);
  });
});
