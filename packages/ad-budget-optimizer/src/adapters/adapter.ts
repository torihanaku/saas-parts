/**
 * AdPlatformAdapter — the injected boundary between this package and real
 * ad-platform APIs (Google Ads / Meta / TikTok, historically via Nango).
 *
 * The original 実運用SaaS code imported a concrete `proxyRequest` Nango
 * client. Here that dependency is injected as `ProxyFn` so the package stays
 * self-contained and testable with in-memory fakes.
 */

/**
 * Low-level proxy call. Mirrors the Nango `proxyRequest` signature used in the
 * source. Returns a response envelope on success, or `null` on transport
 * failure (the adapters treat `null` as a failed mutation).
 */
export type ProxyFn = <T = unknown>(
  tenantId: string,
  integrationId: string,
  connectionId: string,
  method: string,
  endpoint: string,
  body?: unknown,
) => Promise<{ data?: T; status?: number } | null>;

export interface AdapterOptions {
  /** When true, no network call is made and a `dry: true` result is returned. */
  dry_run?: boolean;
  /** Override the proxy implementation (defaults to the injected one). */
  proxyImpl?: ProxyFn;
}

export interface AdapterResult<P extends string = string> {
  ok: boolean;
  platform: P;
  campaignId: string;
  dry?: boolean;
  error?: string;
}

/**
 * A per-platform budget adapter. Each concrete adapter enforces its own field
 * validation, negative-budget guard, dry-run short-circuit, and platform API
 * shape, then returns `ok=false` (never throws) so an orchestrator can surface
 * partial failure across a multi-platform reallocation.
 */
export interface AdPlatformAdapter<P extends string = string, U = unknown> {
  readonly platform: P;
  update(tenantId: string, update: U, opts?: AdapterOptions): Promise<AdapterResult<P>>;
}

/**
 * Feature-flag gate. In the source this was `isEnabled("realtimeBudgetAllocation")`.
 * Here it is injected; default is a permissive always-on gate so the adapters
 * work out of the box.
 */
export type FeatureGate = () => boolean;

export const ALWAYS_ENABLED: FeatureGate = () => true;
