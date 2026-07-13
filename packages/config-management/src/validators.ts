/**
 * Service health check validators.
 * Each function tests connectivity to an external service.
 *
 * 変更点（移植元: 実運用SaaS server/lib/config-validator.ts）:
 * - env 直接参照 → 各バリデータのファクトリ引数で認証情報を注入
 * - 固定8サービス → プラガブルなバリデータレジストリ（組み込み実装はオプション）
 * - fetch はデフォルト globalThis.fetch、テスト・特殊環境向けに注入可能
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HealthCheck {
  service: string;
  category: string;
  status: "ok" | "error" | "skipped";
  latencyMs?: number;
  message?: string;
}

/** 1サービス分のヘルスチェック関数 */
export type HealthValidator = () => Promise<HealthCheck> | HealthCheck;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CommonDeps {
  fetchImpl?: FetchLike;
  /** 各リクエストのタイムアウト（default: 5000ms） */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

function deps(d: CommonDeps): { doFetch: FetchLike; timeoutMs: number } {
  return {
    doFetch: d.fetchImpl ?? ((input, init) => fetch(input, init)),
    timeoutMs: d.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

// ─── Built-in Validators ────────────────────────────────────────────────────

export interface SupabaseValidatorConfig extends CommonDeps {
  url?: string;
  poolerUrl?: string;
  serviceRoleKey?: string;
}

export function createSupabaseValidator(config: SupabaseValidatorConfig): HealthValidator {
  const { doFetch, timeoutMs } = deps(config);
  return async () => {
    const url = config.poolerUrl || config.url;
    if (!url || !config.serviceRoleKey) {
      return { service: "supabase", category: "database", status: "skipped", message: "Not configured" };
    }
    const start = Date.now();
    try {
      const res = await doFetch(`${url}/rest/v1/`, {
        method: "HEAD",
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow redirects on a health check: a 30x from a
        // misconfigured/hostile endpoint would otherwise replay the
        // request (incl. the apikey header, which the fetch spec does NOT
        // strip cross-origin) to an attacker-controlled host. A redirect is
        // treated as a non-ok response instead.
        redirect: "manual",
      });
      return {
        service: "supabase", category: "database",
        status: res.ok || res.status === 406 ? "ok" : "error",
        latencyMs: Date.now() - start,
        message: res.ok || res.status === 406 ? undefined : `HTTP ${res.status}`,
      };
    } catch (e) {
      return { service: "supabase", category: "database", status: "error", latencyMs: Date.now() - start, message: String(e instanceof Error ? e.message : e) };
    }
  };
}

export interface AnthropicValidatorConfig extends CommonDeps {
  apiKey?: string;
}

export function createAnthropicValidator(config: AnthropicValidatorConfig): HealthValidator {
  const { doFetch, timeoutMs } = deps(config);
  return async () => {
    const key = config.apiKey;
    if (!key) return { service: "anthropic", category: "ai", status: "skipped", message: "Not configured" };
    const start = Date.now();
    try {
      const res = await doFetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow redirects on a health check: a 30x from a
        // misconfigured/hostile endpoint would otherwise replay the
        // request (incl. the apikey header, which the fetch spec does NOT
        // strip cross-origin) to an attacker-controlled host. A redirect is
        // treated as a non-ok response instead.
        redirect: "manual",
      });
      return {
        service: "anthropic", category: "ai",
        status: res.ok ? "ok" : "error",
        latencyMs: Date.now() - start,
        message: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (e) {
      return { service: "anthropic", category: "ai", status: "error", latencyMs: Date.now() - start, message: String(e instanceof Error ? e.message : e) };
    }
  };
}

export interface GitHubValidatorConfig extends CommonDeps {
  token?: string;
  /** GitHub API の User-Agent ヘッダ（default: "config-management-health"） */
  userAgent?: string;
}

export function createGitHubValidator(config: GitHubValidatorConfig): HealthValidator {
  const { doFetch, timeoutMs } = deps(config);
  return async () => {
    const token = config.token;
    if (!token) return { service: "github", category: "integration", status: "skipped", message: "Not configured" };
    const start = Date.now();
    try {
      const res = await doFetch("https://api.github.com/rate_limit", {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": config.userAgent ?? "config-management-health" },
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow redirects on a health check: a 30x from a
        // misconfigured/hostile endpoint would otherwise replay the
        // request (incl. the apikey header, which the fetch spec does NOT
        // strip cross-origin) to an attacker-controlled host. A redirect is
        // treated as a non-ok response instead.
        redirect: "manual",
      });
      return {
        service: "github", category: "integration",
        status: res.ok ? "ok" : "error",
        latencyMs: Date.now() - start,
        message: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (e) {
      return { service: "github", category: "integration", status: "error", latencyMs: Date.now() - start, message: String(e instanceof Error ? e.message : e) };
    }
  };
}

export interface SlackValidatorConfig extends CommonDeps {
  botToken?: string;
  clientId?: string;
}

export function createSlackValidator(config: SlackValidatorConfig): HealthValidator {
  const { doFetch, timeoutMs } = deps(config);
  return async () => {
    const token = config.botToken;
    if (!token && !config.clientId) {
      return { service: "slack", category: "integration", status: "skipped", message: "Not configured" };
    }
    if (!token) {
      return { service: "slack", category: "integration", status: "ok", message: "OAuth configured (bot token not set)" };
    }
    const start = Date.now();
    try {
      const res = await doFetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow redirects on a health check: a 30x from a
        // misconfigured/hostile endpoint would otherwise replay the
        // request (incl. the apikey header, which the fetch spec does NOT
        // strip cross-origin) to an attacker-controlled host. A redirect is
        // treated as a non-ok response instead.
        redirect: "manual",
      });
      const data = await res.json() as { ok: boolean; error?: string };
      return {
        service: "slack", category: "integration",
        status: data.ok ? "ok" : "error",
        latencyMs: Date.now() - start,
        message: data.ok ? undefined : data.error,
      };
    } catch (e) {
      return { service: "slack", category: "integration", status: "error", latencyMs: Date.now() - start, message: String(e instanceof Error ? e.message : e) };
    }
  };
}

export interface StripeValidatorConfig extends CommonDeps {
  secretKey?: string;
}

export function createStripeValidator(config: StripeValidatorConfig): HealthValidator {
  const { doFetch, timeoutMs } = deps(config);
  return async () => {
    const key = config.secretKey;
    if (!key) return { service: "stripe", category: "billing", status: "skipped", message: "Not configured" };
    const start = Date.now();
    try {
      const res = await doFetch("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow redirects on a health check: a 30x from a
        // misconfigured/hostile endpoint would otherwise replay the
        // request (incl. the apikey header, which the fetch spec does NOT
        // strip cross-origin) to an attacker-controlled host. A redirect is
        // treated as a non-ok response instead.
        redirect: "manual",
      });
      return {
        service: "stripe", category: "billing",
        status: res.ok ? "ok" : "error",
        latencyMs: Date.now() - start,
        message: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (e) {
      return { service: "stripe", category: "billing", status: "error", latencyMs: Date.now() - start, message: String(e instanceof Error ? e.message : e) };
    }
  };
}

export interface RedisValidatorConfig {
  host?: string;
  /** Redis クライアントの接続状態を返す関数（例: ioredis の status === "ready"） */
  isConnected: () => boolean;
}

export function createRedisValidator(config: RedisValidatorConfig): HealthValidator {
  return () => {
    if (!config.host) {
      return { service: "redis", category: "database", status: "skipped", message: "Not configured (using in-memory cache)" };
    }
    return {
      service: "redis", category: "database",
      status: config.isConnected() ? "ok" : "error",
      message: config.isConnected() ? undefined : "Redis not connected",
    };
  };
}

export interface ResendValidatorConfig extends CommonDeps {
  apiKey?: string;
}

export function createResendValidator(config: ResendValidatorConfig): HealthValidator {
  const { doFetch, timeoutMs } = deps(config);
  return async () => {
    const key = config.apiKey;
    if (!key) return { service: "resend", category: "integration", status: "skipped", message: "Not configured" };
    const start = Date.now();
    try {
      const res = await doFetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow redirects on a health check: a 30x from a
        // misconfigured/hostile endpoint would otherwise replay the
        // request (incl. the apikey header, which the fetch spec does NOT
        // strip cross-origin) to an attacker-controlled host. A redirect is
        // treated as a non-ok response instead.
        redirect: "manual",
      });
      return {
        service: "resend", category: "integration",
        status: res.ok ? "ok" : "error",
        latencyMs: Date.now() - start,
        message: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (e) {
      return { service: "resend", category: "integration", status: "error", latencyMs: Date.now() - start, message: String(e instanceof Error ? e.message : e) };
    }
  };
}

export interface OpenAIValidatorConfig extends CommonDeps {
  apiKey?: string;
}

export function createOpenAIValidator(config: OpenAIValidatorConfig): HealthValidator {
  const { doFetch, timeoutMs } = deps(config);
  return async () => {
    const key = config.apiKey;
    if (!key) return { service: "openai", category: "ai", status: "skipped", message: "Not configured" };
    const start = Date.now();
    try {
      const res = await doFetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeoutMs),
        // Never follow redirects on a health check: a 30x from a
        // misconfigured/hostile endpoint would otherwise replay the
        // request (incl. the apikey header, which the fetch spec does NOT
        // strip cross-origin) to an attacker-controlled host. A redirect is
        // treated as a non-ok response instead.
        redirect: "manual",
      });
      return {
        service: "openai", category: "ai",
        status: res.ok ? "ok" : "error",
        latencyMs: Date.now() - start,
        message: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (e) {
      return { service: "openai", category: "ai", status: "error", latencyMs: Date.now() - start, message: String(e instanceof Error ? e.message : e) };
    }
  };
}

// ─── Builtin Bundle ─────────────────────────────────────────────────────────

export interface BuiltinValidatorsConfig extends CommonDeps {
  supabase?: Omit<SupabaseValidatorConfig, keyof CommonDeps>;
  anthropic?: Omit<AnthropicValidatorConfig, keyof CommonDeps>;
  github?: Omit<GitHubValidatorConfig, keyof CommonDeps>;
  slack?: Omit<SlackValidatorConfig, keyof CommonDeps>;
  stripe?: Omit<StripeValidatorConfig, keyof CommonDeps>;
  redis?: RedisValidatorConfig;
  resend?: Omit<ResendValidatorConfig, keyof CommonDeps>;
  openai?: Omit<OpenAIValidatorConfig, keyof CommonDeps>;
}

/** 移植元と同じ8サービス構成のバリデータ一式を生成する。 */
export function createBuiltinValidators(config: BuiltinValidatorsConfig = {}): Record<string, HealthValidator> {
  const common: CommonDeps = { fetchImpl: config.fetchImpl, timeoutMs: config.timeoutMs };
  return {
    supabase: createSupabaseValidator({ ...common, ...config.supabase }),
    anthropic: createAnthropicValidator({ ...common, ...config.anthropic }),
    github: createGitHubValidator({ ...common, ...config.github }),
    slack: createSlackValidator({ ...common, ...config.slack }),
    stripe: createStripeValidator({ ...common, ...config.stripe }),
    redis: createRedisValidator(config.redis ?? { isConnected: () => false }),
    resend: createResendValidator({ ...common, ...config.resend }),
    openai: createOpenAIValidator({ ...common, ...config.openai }),
  };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export interface HealthCheckRunner {
  /** Run health checks for all registered services. */
  runAll(): Promise<HealthCheck[]>;
  /** Run a single service health check by name. Returns null for unknown names. */
  run(service: string): Promise<HealthCheck | null>;
  /** Register or replace a validator at runtime. */
  register(service: string, validator: HealthValidator): void;
}

export function createHealthCheckRunner(validators: Record<string, HealthValidator>): HealthCheckRunner {
  const registry = new Map<string, HealthValidator>(Object.entries(validators));

  return {
    async runAll(): Promise<HealthCheck[]> {
      const results = await Promise.allSettled(
        [...registry.values()].map(v => Promise.resolve(v())),
      );
      return results.map(r => r.status === "fulfilled" ? r.value : {
        service: "unknown", category: "unknown", status: "error" as const, message: String((r as PromiseRejectedResult).reason),
      });
    },
    async run(service: string): Promise<HealthCheck | null> {
      const fn = registry.get(service);
      if (!fn) return null;
      return fn();
    },
    register(service: string, validator: HealthValidator): void {
      registry.set(service, validator);
    },
  };
}
