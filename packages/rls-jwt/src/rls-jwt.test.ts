/**
 * RLS staged-rollout canary helpers — ported from dev-dashboard-v2
 * tests/rls-jwt.test.ts. process.env mutation is replaced by injected sources
 * (a mutable fixture object read through closures).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";

import { createRlsJwt, decodeTenantJwt, type RlsShadowDiff } from "./index";

const JWT_SECRET = "test-jwt-secret-with-enough-entropy";
const SERVICE_ROLE_KEY = "test-service-role-key";

function makeFixture() {
  const cfg = {
    jwtSecret: JWT_SECRET as string | undefined,
    apiKey: SERVICE_ROLE_KEY as string | undefined,
    stage: undefined as string | undefined,
  };
  const rls = createRlsJwt({
    jwtSecret: () => cfg.jwtSecret,
    apiKey: () => cfg.apiKey,
    stage: () => cfg.stage,
  });
  return { cfg, rls };
}

describe("getRlsStage", () => {
  it("defaults to Stage 1 when stage source is unset", () => {
    const { rls } = makeFixture();
    expect(rls.getRlsStage()).toBe(1);
  });

  it("returns Stage 2 when stage='2'", () => {
    const { cfg, rls } = makeFixture();
    cfg.stage = "2";
    expect(rls.getRlsStage()).toBe(2);
  });

  it("returns Stage 3 when stage='3'", () => {
    const { cfg, rls } = makeFixture();
    cfg.stage = "3";
    expect(rls.getRlsStage()).toBe(3);
  });

  it("falls back to Stage 1 for invalid values", () => {
    const { cfg, rls } = makeFixture();
    cfg.stage = "999";
    expect(rls.getRlsStage()).toBe(1);
  });

  it("caches the resolved stage between calls", () => {
    const { cfg, rls } = makeFixture();
    cfg.stage = "2";
    expect(rls.getRlsStage()).toBe(2);
    cfg.stage = "3";
    // No reset → cached Stage 2 still returned
    expect(rls.getRlsStage()).toBe(2);
  });

  it("re-reads the stage source after _resetRlsStageCache()", () => {
    const { cfg, rls } = makeFixture();
    cfg.stage = "2";
    expect(rls.getRlsStage()).toBe(2);
    cfg.stage = "3";
    rls._resetRlsStageCache();
    expect(rls.getRlsStage()).toBe(3);
  });
});

describe("mintTenantJwt", () => {
  const tenantId = "11111111-2222-3333-4444-555555555555";

  it("produces a 3-segment JWT", () => {
    const { rls } = makeFixture();
    const jwt = rls.mintTenantJwt(tenantId);
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("encodes tenant_id and role=authenticated by default", () => {
    const { rls } = makeFixture();
    const jwt = rls.mintTenantJwt(tenantId);
    const payload = decodeTenantJwt(jwt);
    expect(payload).not.toBeNull();
    expect(payload?.tenant_id).toBe(tenantId);
    expect(payload?.role).toBe("authenticated");
    expect(typeof payload?.iat).toBe("number");
    expect(typeof payload?.exp).toBe("number");
  });

  it("respects custom role and exp", () => {
    const { rls } = makeFixture();
    const jwt = rls.mintTenantJwt(tenantId, { role: "anon", expSec: 60 });
    const payload = decodeTenantJwt(jwt);
    expect(payload?.role).toBe("anon");
    expect((payload?.exp as number) - (payload?.iat as number)).toBe(60);
  });

  it("includes sub when provided", () => {
    const { rls } = makeFixture();
    const jwt = rls.mintTenantJwt(tenantId, { sub: "user-42" });
    expect(decodeTenantJwt(jwt)?.sub).toBe("user-42");
  });

  it("produces a signature verifiable with the injected secret", () => {
    const { rls } = makeFixture();
    const jwt = rls.mintTenantJwt(tenantId);
    const [headerEnc, payloadEnc, sig] = jwt.split(".");
    const expected = createHmac("sha256", JWT_SECRET)
      .update(`${headerEnc}.${payloadEnc}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(sig).toBe(expected);
  });

  it("throws when tenantId is empty", () => {
    const { rls } = makeFixture();
    expect(() => rls.mintTenantJwt("")).toThrow(/non-empty tenantId/);
  });

  it("throws when the JWT secret is unset (read at mint time, not creation time)", () => {
    const { cfg, rls } = makeFixture();
    cfg.jwtSecret = undefined;
    expect(() => rls.mintTenantJwt("tenant-x")).toThrow(/JWT secret/);
    // Rotation back takes effect immediately without recreating the instance.
    cfg.jwtSecret = JWT_SECRET;
    expect(rls.mintTenantJwt("tenant-x").split(".")).toHaveLength(3);
  });
});

describe("tenantScopedHeaders", () => {
  it("returns Authorization with the minted JWT and apikey from the injected source", () => {
    const { rls } = makeFixture();
    const headers = rls.tenantScopedHeaders("tenant-abc");
    expect(headers.Authorization!.startsWith("Bearer ")).toBe(true);
    expect(headers.Authorization!.split(".").length).toBe(3); // Bearer header.payload.sig
    expect(headers.apikey).toBe(SERVICE_ROLE_KEY);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("falls back to empty apikey when the source is unset", () => {
    const { cfg, rls } = makeFixture();
    cfg.apiKey = undefined;
    expect(rls.tenantScopedHeaders("tenant-abc").apikey).toBe("");
  });
});

describe("runWithRlsShadow", () => {
  let fixture: ReturnType<typeof makeFixture>;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture.rls._resetRlsStageCache();
    fixture.rls._resetShadowSubscriber();
    vi.restoreAllMocks();
  });

  it("returns primary directly when stage != 2 (Stage 1)", async () => {
    fixture.cfg.stage = "1";
    const primary = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: 1 }] });
    const shadow = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: 1 }] });
    const result = await fixture.rls.runWithRlsShadow("test_fn", primary, shadow);
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(primary).toHaveBeenCalledOnce();
    expect(shadow).not.toHaveBeenCalled();
  });

  it("returns primary directly when stage != 2 (Stage 3)", async () => {
    fixture.cfg.stage = "3";
    const primary = vi.fn().mockResolvedValue({ ok: true, rows: [] });
    const shadow = vi.fn().mockResolvedValue({ ok: true, rows: [] });
    await fixture.rls.runWithRlsShadow("test_fn", primary, shadow);
    expect(primary).toHaveBeenCalledOnce();
    expect(shadow).not.toHaveBeenCalled();
  });

  it("runs both and emits diff when stage = 2", async () => {
    fixture.cfg.stage = "2";
    const primary = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: 1 }, { id: 2 }] });
    const shadow = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: 1 }, { id: 2 }] });
    const seen: RlsShadowDiff[] = [];
    fixture.rls.onRlsShadowDiff((d) => seen.push(d));

    const result = await fixture.rls.runWithRlsShadow("test_fn", primary, shadow);
    expect(primary).toHaveBeenCalledOnce();
    expect(shadow).toHaveBeenCalledOnce();
    expect(result.rows.length).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.match).toBe(true);
    expect(seen[0]!.primaryCount).toBe(2);
    expect(seen[0]!.shadowCount).toBe(2);
  });

  it("logs a warning and emits mismatch when row counts diverge in stage 2", async () => {
    fixture.cfg.stage = "2";
    const warnings: Record<string, unknown>[] = [];
    const rls = createRlsJwt({
      jwtSecret: () => JWT_SECRET,
      stage: () => "2",
      warn: (e) => warnings.push(e),
    });
    const primary = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: 1 }] });
    const shadow = vi.fn().mockResolvedValue({ ok: true, rows: [] });
    const seen: RlsShadowDiff[] = [];
    rls.onRlsShadowDiff((d) => seen.push(d));

    await rls.runWithRlsShadow("mismatch_fn", primary, shadow);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.match).toBe(false);
    const messages = warnings.map((w) => `${w.message} ${w.fn ?? ""}`).join("\n");
    expect(messages).toMatch(/rls_shadow_mismatch/);
    expect(messages).toMatch(/mismatch_fn/);
  });

  it("returns primary even if shadow throws (shadow must not block prod)", async () => {
    fixture.cfg.stage = "2";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const primary = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: 1 }] });
    const shadow = vi.fn().mockRejectedValue(new Error("jwt failure"));
    const result = await fixture.rls.runWithRlsShadow("shadow_throw", primary, shadow);
    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([{ id: 1 }]);
  });

  it("subscriber exception does not break the primary path", async () => {
    fixture.cfg.stage = "2";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const primary = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: 1 }] });
    const shadow = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: 1 }] });
    fixture.rls.onRlsShadowDiff(() => {
      throw new Error("observer crash");
    });
    const result = await fixture.rls.runWithRlsShadow("subscriber_throws", primary, shadow);
    expect(result.rows).toEqual([{ id: 1 }]);
  });
});

describe("decodeTenantJwt", () => {
  it("returns null for malformed tokens", () => {
    expect(decodeTenantJwt("not-a-jwt")).toBeNull();
    expect(decodeTenantJwt("a.b")).toBeNull();
  });
});
