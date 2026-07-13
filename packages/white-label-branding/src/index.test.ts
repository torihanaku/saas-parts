import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isPartnerPlanTier,
  isPartnerRelationshipStatus,
  PARTNER_PLAN_TIERS,
  PARTNER_RELATIONSHIP_STATUSES,
  validateWhiteLabelConfigUpdate,
  validateCreatePartnerClient,
  createWhiteLabelBranding,
  type WhiteLabelStore,
  type WhiteLabelConfig,
} from "./index";

// ── type guards / validators (ported from white-label.test.ts) ──
describe("type guards", () => {
  it.each(PARTNER_PLAN_TIERS)("isPartnerPlanTier('%s')", (t) => {
    expect(isPartnerPlanTier(t)).toBe(true);
  });
  it("rejects unknown tier/status", () => {
    expect(isPartnerPlanTier("ultra")).toBe(false);
    expect(isPartnerRelationshipStatus("paused")).toBe(false);
    expect(isPartnerRelationshipStatus("active ")).toBe(false);
  });
  it("PARTNER_PLAN_TIERS order", () => {
    expect(PARTNER_PLAN_TIERS).toEqual(["starter", "growth", "enterprise"]);
    expect(PARTNER_RELATIONSHIP_STATUSES).toEqual(["active", "suspended", "churned"]);
  });
});

describe("validateWhiteLabelConfigUpdate", () => {
  it("accepts empty object", () => {
    const r = validateWhiteLabelConfigUpdate({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });
  it("accepts brand_name + url fields", () => {
    const r = validateWhiteLabelConfigUpdate({
      brand_name: "Acme",
      logo_url: "https://example.com/logo.png",
      custom_domain: "app.acme.com",
    });
    expect(r.ok).toBe(true);
  });
  it("rejects non-string brand_name and oversized fields", () => {
    expect(validateWhiteLabelConfigUpdate({ brand_name: 123 }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ logo_url: 42 }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ footer_html: "x".repeat(4001) }).ok).toBe(false);
  });

  // Regression: these fields are rendered on the white-labeled page (logo/favicon
  // src, primary_color inline style, footer_html HTML). Original only length-checked
  // → javascript:/data: URLs, CSS-break colors, <script> footers passed → stored XSS.
  it("rejects javascript:/data: and non-http(s) URLs in logo_url/favicon_url", () => {
    expect(validateWhiteLabelConfigUpdate({ logo_url: "javascript:alert(1)" }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ favicon_url: "data:text/html,<script>alert(1)</script>" }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ logo_url: "//evil.com/x.png" }).ok).toBe(false);
  });
  it("accepts http(s) and root-relative URLs, and null to clear", () => {
    expect(validateWhiteLabelConfigUpdate({ logo_url: "https://cdn.acme.com/l.png" }).ok).toBe(true);
    expect(validateWhiteLabelConfigUpdate({ logo_url: "/assets/l.png" }).ok).toBe(true);
    expect(validateWhiteLabelConfigUpdate({ logo_url: null }).ok).toBe(true);
  });
  it("rejects CSS-breaking primary_color, accepts safe colors", () => {
    expect(validateWhiteLabelConfigUpdate({ primary_color: "red;}body{display:none}" }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ primary_color: "url(javascript:alert(1))" }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ primary_color: "#1a2b3c" }).ok).toBe(true);
    expect(validateWhiteLabelConfigUpdate({ primary_color: "rgb(10,20,30)" }).ok).toBe(true);
    expect(validateWhiteLabelConfigUpdate({ primary_color: "rebeccapurple" }).ok).toBe(true);
  });
  it("rejects scheme/path/angle-brackets in custom_domain, accepts bare host", () => {
    expect(validateWhiteLabelConfigUpdate({ custom_domain: "evil.com/x?<script>" }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ custom_domain: "https://acme.com" }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ custom_domain: "app.acme.com" }).ok).toBe(true);
  });
  it("rejects dangerous footer_html, accepts benign markup", () => {
    expect(validateWhiteLabelConfigUpdate({ footer_html: "<script>alert(1)</script>" }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ footer_html: "<img src=x onerror=alert(1)>" }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ footer_html: "<a href='javascript:alert(1)'>x</a>" }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ footer_html: "<iframe src='x'></iframe>" }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ footer_html: "<p>© 2026 Acme</p>" }).ok).toBe(true);
  });
  it("rejects header-injection newlines in custom_email_from", () => {
    expect(validateWhiteLabelConfigUpdate({ custom_email_from: "a@b.com\nBcc: x@y.com" }).ok).toBe(false);
    expect(validateWhiteLabelConfigUpdate({ custom_email_from: "Acme <no-reply@acme.com>" }).ok).toBe(true);
  });
});

describe("validateCreatePartnerClient", () => {
  it("accepts minimal + full body", () => {
    expect(validateCreatePartnerClient({ client_tenant_id: "abc" }).ok).toBe(true);
    const r = validateCreatePartnerClient({
      client_tenant_id: "abc",
      plan_tier: "growth",
      reseller_pricing_jpy: 50000,
      status: "active",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.plan_tier).toBe("growth");
  });
  it("accepts null reseller_pricing_jpy", () => {
    const r = validateCreatePartnerClient({ client_tenant_id: "abc", reseller_pricing_jpy: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.reseller_pricing_jpy).toBeNull();
  });
  it("rejects invalid inputs", () => {
    expect(validateCreatePartnerClient({}).ok).toBe(false);
    expect(validateCreatePartnerClient({ client_tenant_id: "" }).ok).toBe(false);
    expect(validateCreatePartnerClient({ client_tenant_id: "a", plan_tier: "ultra" }).ok).toBe(false);
    expect(validateCreatePartnerClient({ client_tenant_id: "a", reseller_pricing_jpy: -1 }).ok).toBe(false);
    expect(validateCreatePartnerClient({ client_tenant_id: "a", reseller_pricing_jpy: 12.5 }).ok).toBe(false);
    expect(validateCreatePartnerClient({ client_tenant_id: "a", status: "paused" }).ok).toBe(false);
    expect(validateCreatePartnerClient(null).ok).toBe(false);
  });
});

// ── lib against injected store ──
function makeStore(overrides: Partial<WhiteLabelStore> = {}): WhiteLabelStore {
  return {
    getConfig: vi.fn(async () => null),
    insertConfig: vi.fn(async () => ({ ok: true })),
    patchConfig: vi.fn(async () => ({ ok: true })),
    hasActiveRelationship: vi.fn(async () => false),
    listRelationships: vi.fn(async () => []),
    insertRelationship: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

const sampleConfig = (over: Partial<WhiteLabelConfig> = {}): WhiteLabelConfig => ({
  tenant_id: "t1",
  brand_name: "Acme",
  logo_url: null,
  primary_color: null,
  favicon_url: null,
  custom_domain: null,
  custom_email_from: null,
  footer_html: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("getWhiteLabelConfig", () => {
  it("returns config when present", async () => {
    const store = makeStore({ getConfig: vi.fn(async () => sampleConfig()) });
    const wl = createWhiteLabelBranding(store);
    expect(await wl.getWhiteLabelConfig("t1")).toMatchObject({ tenant_id: "t1", brand_name: "Acme" });
  });
  it("returns null when empty tenantId without hitting store", async () => {
    const store = makeStore();
    const wl = createWhiteLabelBranding(store);
    expect(await wl.getWhiteLabelConfig("")).toBeNull();
    expect(store.getConfig).not.toHaveBeenCalled();
  });
  it("returns null on store error", async () => {
    const store = makeStore({ getConfig: vi.fn(async () => { throw new Error("net"); }) });
    expect(await createWhiteLabelBranding(store).getWhiteLabelConfig("t1")).toBeNull();
  });
});

describe("upsertWhiteLabelConfig", () => {
  it("inserts when none exists", async () => {
    const getConfig = vi.fn(async () => null as WhiteLabelConfig | null);
    getConfig.mockResolvedValueOnce(null).mockResolvedValueOnce(sampleConfig());
    const store = makeStore({ getConfig });
    const wl = createWhiteLabelBranding(store);
    const cfg = await wl.upsertWhiteLabelConfig("t1", { brand_name: "Acme" });
    expect(store.insertConfig).toHaveBeenCalledWith("t1", expect.objectContaining({ brand_name: "Acme" }));
    expect(cfg).toMatchObject({ tenant_id: "t1" });
  });
  it("patches when existing", async () => {
    const getConfig = vi.fn();
    getConfig.mockResolvedValueOnce(sampleConfig({ brand_name: "Old" })).mockResolvedValueOnce(sampleConfig({ brand_name: "New" }));
    const store = makeStore({ getConfig });
    const cfg = await createWhiteLabelBranding(store).upsertWhiteLabelConfig("t1", { brand_name: "New" });
    expect(store.patchConfig).toHaveBeenCalledWith("t1", { brand_name: "New" });
    expect(cfg).toMatchObject({ brand_name: "New" });
  });
  it("returns null when insert fails", async () => {
    const store = makeStore({ insertConfig: vi.fn(async () => ({ ok: false, error: "boom" })) });
    expect(await createWhiteLabelBranding(store).upsertWhiteLabelConfig("t1", { brand_name: "Acme" })).toBeNull();
  });
  it("returns null on empty tenantId", async () => {
    const store = makeStore();
    expect(await createWhiteLabelBranding(store).upsertWhiteLabelConfig("", {})).toBeNull();
    expect(store.insertConfig).not.toHaveBeenCalled();
    expect(store.patchConfig).not.toHaveBeenCalled();
  });
});

describe("assertPartnerOwnsClient", () => {
  it("true when active relationship exists", async () => {
    const store = makeStore({ hasActiveRelationship: vi.fn(async () => true) });
    expect(await createWhiteLabelBranding(store).assertPartnerOwnsClient("p1", "c1")).toBe(true);
  });
  it("false when partner==client or empty ids without hitting store", async () => {
    const store = makeStore();
    const wl = createWhiteLabelBranding(store);
    expect(await wl.assertPartnerOwnsClient("same", "same")).toBe(false);
    expect(await wl.assertPartnerOwnsClient("", "c")).toBe(false);
    expect(store.hasActiveRelationship).not.toHaveBeenCalled();
  });
  it("false on store error", async () => {
    const store = makeStore({ hasActiveRelationship: vi.fn(async () => { throw new Error("x"); }) });
    expect(await createWhiteLabelBranding(store).assertPartnerOwnsClient("p1", "c1")).toBe(false);
  });
});

describe("listPartnerClients / createPartnerRelationship", () => {
  it("lists with status filter", async () => {
    const store = makeStore({ listRelationships: vi.fn(async () => [{ client_tenant_id: "c1" }]) });
    const rows = await createWhiteLabelBranding(store).listPartnerClients("p1", { status: "active" });
    expect(rows).toHaveLength(1);
    expect(store.listRelationships).toHaveBeenCalledWith("p1", "active");
  });
  it("creates relationship with defaults", async () => {
    const store = makeStore();
    const ok = await createWhiteLabelBranding(store).createPartnerRelationship("p1", "c1");
    expect(ok).toBe(true);
    expect(store.insertRelationship).toHaveBeenCalledWith(
      expect.objectContaining({ plan_tier: "starter", status: "active", reseller_pricing_jpy: null }),
    );
  });
  it("rejects partner==client", async () => {
    const store = makeStore();
    expect(await createWhiteLabelBranding(store).createPartnerRelationship("x", "x")).toBe(false);
    expect(store.insertRelationship).not.toHaveBeenCalled();
  });
});
