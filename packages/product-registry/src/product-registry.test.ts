/**
 * Tests for @torihanaku/product-registry.
 * No tests existed for the source module; this is a focused suite covering
 * the registry mechanics (lookup, price resolution, URL resolution, DB sync,
 * env validation) using the injected env map and in-memory store.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ProductRegistry,
  InMemoryProductStore,
  EXAMPLE_PRODUCTS,
} from "./index.js";
import type { ExampleProductKey, ProductStore } from "./index.js";

function makeRegistry(
  overrides: Partial<ConstructorParameters<typeof ProductRegistry<ExampleProductKey>>[0]> = {},
) {
  return new ProductRegistry<ExampleProductKey>({
    products: EXAMPLE_PRODUCTS,
    ...overrides,
  });
}

// ─── getProduct / keys ────────────────────────────────────────────────────────

describe("getProduct", () => {
  it("returns the product config for a known key", () => {
    const registry = makeRegistry();
    const p = registry.getProduct("analytics");
    expect(p.name).toBe("Acme Analytics");
    expect(p.requiredEntitlement).toBe("product:analytics");
    expect(p.validEntitlements).toContain("reports:unlimited");
  });

  it("throws for an unknown key", () => {
    const registry = makeRegistry();
    expect(() => registry.getProduct("nope" as ExampleProductKey)).toThrow(
      "Unknown product key: nope",
    );
  });

  it("lists all keys", () => {
    expect(makeRegistry().keys.sort()).toEqual(["analytics", "platform"]);
  });
});

// ─── resolveStripePrice (injected env, no process.env) ────────────────────────

describe("resolveStripePrice", () => {
  it("resolves the price ID via the injected env map", () => {
    const registry = makeRegistry({
      env: { STRIPE_ANALYTICS_PRO_PRICE_ID: "price_fake_pro_123" },
    });
    expect(registry.resolveStripePrice("analytics", "pro")).toBe("price_fake_pro_123");
  });

  it("returns undefined when the env var has no value", () => {
    const registry = makeRegistry({ env: {} });
    expect(registry.resolveStripePrice("analytics", "pro")).toBeUndefined();
  });

  it("returns undefined when the product declares no price for the plan", () => {
    const registry = makeRegistry({
      env: { STRIPE_ANALYTICS_PRO_PRICE_ID: "price_fake" },
    });
    expect(registry.resolveStripePrice("analytics", "free")).toBeUndefined();
    expect(registry.resolveStripePrice("platform", "pro")).toBeUndefined();
  });
});

// ─── resolveProductUrl ────────────────────────────────────────────────────────

describe("resolveProductUrl", () => {
  it("uses devBaseUrl outside production (source: localhost:PORT)", () => {
    const registry = makeRegistry({ isProduction: false, devBaseUrl: "http://localhost:4000" });
    expect(registry.resolveProductUrl("analytics")).toBe("http://localhost:4000/analytics");
  });

  it("defaults devBaseUrl to http://localhost:5174 (source default)", () => {
    const registry = makeRegistry();
    expect(registry.resolveProductUrl("platform")).toBe("http://localhost:5174/platform");
  });

  it("prefers an explicit baseUrl in production", () => {
    const registry = makeRegistry({ isProduction: true, productionDomain: "example.com" });
    expect(registry.resolveProductUrl("analytics", "https://app.example.com")).toBe(
      "https://app.example.com/analytics",
    );
  });

  it("falls back to https://{subdomain}.{productionDomain} in production", () => {
    const registry = makeRegistry({ isProduction: true, productionDomain: "example.com" });
    expect(registry.resolveProductUrl("analytics")).toBe("https://analytics.example.com");
  });

  it("throws in production when neither baseUrl nor productionDomain is set", () => {
    const registry = makeRegistry({ isProduction: true });
    expect(() => registry.resolveProductUrl("analytics")).toThrow(/productionDomain/);
  });
});

// ─── syncProductsToDb ─────────────────────────────────────────────────────────

describe("syncProductsToDb", () => {
  it("upserts one row per product via the injected store", async () => {
    const store = new InMemoryProductStore();
    const registry = makeRegistry({ store });
    await registry.syncProductsToDb();

    expect(store.rows).toHaveLength(2);
    const analytics = store.rows.find((r) => r.key === "analytics");
    expect(analytics).toEqual({
      key: "analytics",
      name: "Acme Analytics",
      short_name: "Analytics",
      default_subdomain: "analytics",
      default_path: "/dashboard",
      status: "active",
    });
  });

  it("is idempotent (merge-duplicates semantics)", async () => {
    const store = new InMemoryProductStore();
    const registry = makeRegistry({ store });
    await registry.syncProductsToDb();
    await registry.syncProductsToDb();
    expect(store.rows).toHaveLength(2);
  });

  it("warns instead of throwing when the store fails (source behavior)", async () => {
    const warn = vi.fn();
    const failing: ProductStore = {
      upsertProducts: vi.fn().mockRejectedValue(new Error("db down")),
    };
    const registry = makeRegistry({ store: failing, logger: { warn } });
    await expect(registry.syncProductsToDb()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("syncProductsToDb failed: db down"),
    );
  });

  it("is a no-op without a store", async () => {
    await expect(makeRegistry().syncProductsToDb()).resolves.toBeUndefined();
  });
});

// ─── validateEnvironment ──────────────────────────────────────────────────────

describe("validateEnvironment", () => {
  it("returns no warnings when all active products' prices resolve", () => {
    const warn = vi.fn();
    const registry = makeRegistry({
      env: {
        STRIPE_ANALYTICS_PRO_PRICE_ID: "price_fake_pro",
        STRIPE_ANALYTICS_ENTERPRISE_PRICE_ID: "price_fake_ent",
      },
      logger: { warn },
    });
    expect(registry.validateEnvironment()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns about missing env vars for active products", () => {
    const warn = vi.fn();
    const registry = makeRegistry({
      env: { STRIPE_ANALYTICS_PRO_PRICE_ID: "price_fake_pro" },
      logger: { warn },
    });
    const warnings = registry.validateEnvironment();
    expect(warnings).toEqual([
      "analytics.enterprise: missing env var STRIPE_ANALYTICS_ENTERPRISE_PRICE_ID",
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Missing Stripe price env vars"),
    );
  });

  it("skips non-active products", () => {
    const registry = new ProductRegistry({
      products: {
        beta: {
          ...EXAMPLE_PRODUCTS.analytics,
          key: "beta",
          status: "beta" as const,
        },
      },
      env: {},
      logger: { warn: vi.fn() },
    });
    expect(registry.validateEnvironment()).toEqual([]);
  });
});
