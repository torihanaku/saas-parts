/**
 * Product registry — central declaration of products × plans × Stripe price
 * env-var names × entitlements, with startup DB sync.
 *
 * Ported from dev-dashboard-v2 `server/lib/product-registry.ts` (+ types from
 * `shared/types/product.ts`). Coupling removed:
 * - Product definitions (5 Folia products in the source) are caller config;
 *   EXAMPLE_PRODUCTS documents the shape with a 2-product example.
 * - `process.env` reads (resolveStripePrice / validateProductEnvironment /
 *   resolveProductUrl) are replaced by an injected env map + explicit
 *   isProduction / devBaseUrl / productionDomain options.
 * - syncProductsToDb's supabase `products` upsert is an injected `ProductStore`;
 *   an in-memory implementation is provided.
 */

// ─── Types (from shared/types/product.ts) ─────────────────────────────────────

export type PlanKey = "free" | "pro" | "enterprise";
export type ProductStatus = "draft" | "beta" | "active" | "deprecated";

export interface ProductConfig<K extends string = string> {
  key: K;
  name: string;
  shortName: string;
  description: string;
  defaultSubdomain: string;
  defaultPath: string;
  /** Entitlement required to access this product (omit for the base platform). */
  requiredEntitlement?: string;
  enabledFeatureFlags: string[];
  navItemIds: string[];
  /** Plan → **env-var name** holding the Stripe Price ID (values injected via `env`). */
  stripePrices: Partial<Record<PlanKey, string>>;
  /** Entitlement keys this product may grant/declare. */
  validEntitlements: string[];
  status: ProductStatus;
}

// ─── DB sync store ────────────────────────────────────────────────────────────

/** Row shape persisted at startup (matches the source's supabase `products` upsert). */
export interface ProductRow {
  key: string;
  name: string;
  short_name: string;
  default_subdomain: string;
  default_path: string;
  status: ProductStatus;
}

/** Replaces the supabase `products` table upsert (Prefer: resolution=merge-duplicates). */
export interface ProductStore {
  upsertProducts(rows: ProductRow[]): Promise<void>;
}

/** In-memory implementation — suitable for tests and single-process dev. */
export class InMemoryProductStore implements ProductStore {
  private readonly byKey = new Map<string, ProductRow>();

  async upsertProducts(rows: ProductRow[]): Promise<void> {
    for (const row of rows) this.byKey.set(row.key, row);
  }

  get rows(): ProductRow[] {
    return [...this.byKey.values()];
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export interface ProductRegistryOptions<K extends string> {
  /** Product definitions (see EXAMPLE_PRODUCTS). */
  products: Record<K, ProductConfig<K>>;
  /** Injected env map for Stripe price resolution (replaces process.env reads). */
  env?: Record<string, string | undefined>;
  /** Startup DB sync target (replaces the supabase `products` upsert). */
  store?: ProductStore;
  /** Replaces the source's NODE_ENV === "production" check. @default false */
  isProduction?: boolean;
  /** Dev URL base (source: `http://localhost:${PORT ?? 5174}`). @default "http://localhost:5174" */
  devBaseUrl?: string;
  /** Production apex domain for `https://{subdomain}.{domain}` URLs (source: "folia.la"). */
  productionDomain?: string;
  /** Warning sink. @default console */
  logger?: { warn(message: string): void };
}

export class ProductRegistry<K extends string = string> {
  readonly products: Record<K, ProductConfig<K>>;
  private readonly env: Record<string, string | undefined>;
  private readonly store?: ProductStore;
  private readonly isProduction: boolean;
  private readonly devBaseUrl: string;
  private readonly productionDomain?: string;
  private readonly logger: { warn(message: string): void };

  constructor(options: ProductRegistryOptions<K>) {
    this.products = options.products;
    this.env = options.env ?? {};
    this.store = options.store;
    this.isProduction = options.isProduction ?? false;
    this.devBaseUrl = options.devBaseUrl ?? "http://localhost:5174";
    this.productionDomain = options.productionDomain;
    this.logger = options.logger ?? console;
  }

  /** All product keys. */
  get keys(): K[] {
    return Object.keys(this.products) as K[];
  }

  getProduct(key: K): ProductConfig<K> {
    const p = this.products[key];
    if (!p) throw new Error(`Unknown product key: ${key}`);
    return p;
  }

  /**
   * Resolve the Stripe Price ID for (product, plan) via the injected env map.
   * Returns undefined when the product declares no env-var name for the plan
   * or the env map has no value for it.
   */
  resolveStripePrice(productKey: K, planKey: PlanKey): string | undefined {
    const envVarName = this.products[productKey]?.stripePrices[planKey];
    return envVarName ? this.env[envVarName] : undefined;
  }

  /**
   * Resolve the public URL of a product.
   * Dev: `${devBaseUrl}/${key}`; prod: `${baseUrl}/${key}` when baseUrl given,
   * else `https://{subdomain}.{productionDomain}` (source hardcoded folia.la).
   */
  resolveProductUrl(key: K, baseUrl?: string): string {
    const p = this.getProduct(key);
    if (!this.isProduction) {
      return `${this.devBaseUrl}/${key}`;
    }
    if (baseUrl) return `${baseUrl}/${key}`;
    if (this.productionDomain) return `https://${p.defaultSubdomain}.${this.productionDomain}`;
    throw new Error(
      `resolveProductUrl(${key}): set productionDomain or pass baseUrl in production`,
    );
  }

  /** Startup DB sync — upsert product rows via the injected store. Failures only warn. */
  async syncProductsToDb(): Promise<void> {
    if (!this.store) return;
    try {
      const rows: ProductRow[] = Object.values<ProductConfig<K>>(this.products).map((p) => ({
        key: p.key,
        name: p.name,
        short_name: p.shortName,
        default_subdomain: p.defaultSubdomain,
        default_path: p.defaultPath,
        status: p.status,
      }));
      await this.store.upsertProducts(rows);
    } catch (err) {
      this.logger.warn(
        `[product-registry] syncProductsToDb failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Startup validation — warn about active products whose declared Stripe
   * price env-var names have no value in the injected env map.
   * Returns the warnings (also sent to the logger), so callers can assert.
   */
  validateEnvironment(): string[] {
    const warnings: string[] = [];
    for (const p of Object.values<ProductConfig<K>>(this.products)) {
      if (p.status !== "active") continue;
      for (const [planKey, envVarName] of Object.entries(p.stripePrices)) {
        if (envVarName && !this.env[envVarName]) {
          warnings.push(`${p.key}.${planKey}: missing env var ${envVarName}`);
        }
      }
    }
    if (warnings.length > 0) {
      this.logger.warn(
        "[product-registry] Missing Stripe price env vars:\n  " + warnings.join("\n  "),
      );
    }
    return warnings;
  }
}

// ─── Documented example (2 products) ──────────────────────────────────────────

export type ExampleProductKey = "platform" | "analytics";

/**
 * Example product definitions. The source declared 5 product-specific entries;
 * these 2 document the shape: a base "platform" (no entitlement, no prices)
 * and a paid add-on product with plan-keyed Stripe price env-var names.
 */
export const EXAMPLE_PRODUCTS: Record<ExampleProductKey, ProductConfig<ExampleProductKey>> = {
  platform: {
    key: "platform",
    name: "Acme Platform",
    shortName: "Platform",
    description: "共通プラットフォーム（課金なしの土台）",
    defaultSubdomain: "app",
    defaultPath: "/home",
    enabledFeatureFlags: [],
    navItemIds: ["home", "billing", "team", "settings"],
    stripePrices: {},
    validEntitlements: [],
    status: "active",
  },
  analytics: {
    key: "analytics",
    name: "Acme Analytics",
    shortName: "Analytics",
    description: "分析アドオン — プランごとに Stripe Price を持つ有償プロダクト例",
    defaultSubdomain: "analytics",
    defaultPath: "/dashboard",
    requiredEntitlement: "product:analytics",
    enabledFeatureFlags: ["analytics", "aiInsights"],
    navItemIds: ["dashboard", "reports", "settings"],
    stripePrices: {
      pro: "STRIPE_ANALYTICS_PRO_PRICE_ID",
      enterprise: "STRIPE_ANALYTICS_ENTERPRISE_PRICE_ID",
    },
    validEntitlements: ["product:analytics", "reports:unlimited"],
    status: "active",
  },
};
