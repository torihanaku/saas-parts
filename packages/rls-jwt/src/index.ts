/**
 * RLS staged-rollout canary helpers — tenant-scoped JWT minting for Postgres RLS.
 *
 * The stage value controls how tenant-partitioned tables are authorized when
 * queried via PostgREST RPC:
 *
 *   1 — service_role headers only. tenant_id is filtered at the application
 *       layer. Stage 1 is the default; safe to ship without ops promotion.
 *
 *   2 — Canary. service_role is the primary path. A shadow query runs in
 *       parallel under a tenant-scoped JWT (HS256, signed with the injected
 *       secret). Result counts are compared and mismatches are logged
 *       (severity=WARNING, message=rls_shadow_mismatch). Soak ≥ 7 days before
 *       promoting to Stage 3.
 *
 *   3 — tenant-JWT primary. service_role is only for cross-tenant admin
 *       (e.g. GDPR cascade). The legacy service_role_all policy on the
 *       tenant-partitioned table should be DROPped before flipping to Stage 3.
 *
 * The minted JWT carries `tenant_id` and `role=authenticated`. PostgREST
 * verifies the signature against the same secret and exposes the claim through
 * current_setting('request.jwt.claims',true)::json which the RLS policy uses.
 *
 * All configuration is injected (no process.env reads). Sources are functions,
 * not values, because stage/secret rotation must take effect without a process
 * restart: the stage source is re-read after `_resetRlsStageCache()`, and the
 * secret source is re-read on every mint.
 */

import { createHmac } from "node:crypto";

export type RlsStage = 1 | 2 | 3;

export interface RlsJwtSources {
  /**
   * JWT signing secret (Supabase なら SUPABASE_JWT_SECRET 相当)。
   * mint のたびに呼ばれる — ローテーションを再起動なしで反映するため。
   * 未設定（空/undefined）のとき mintTenantJwt は throw する。
   */
  jwtSecret: () => string | undefined;
  /**
   * PostgREST の apikey ヘッダに載せる値（service_role key 相当）。
   * tenantScopedHeaders 呼び出しごとに読まれる。省略時は空文字。
   */
  apiKey?: () => string | undefined;
  /**
   * ステージの生値（"1" | "2" | "3" 相当の文字列）。unset/不正値は Stage 1。
   * 初回解決後はキャッシュされ、_resetRlsStageCache() で再読込される。
   */
  stage?: () => string | undefined;
  /**
   * 構造化 WARNING の出力先。省略時は console.warn(JSON.stringify(entry))。
   */
  warn?: (entry: Record<string, unknown>) => void;
  /** 時刻源（テスト用）。省略時 Date.now。 */
  now?: () => number;
}

export interface MintTenantJwtOptions {
  role?: string;
  expSec?: number;
  sub?: string;
}

export interface RlsShadowDiff {
  fn: string;
  primaryCount: number;
  shadowCount: number;
  match: boolean;
  ms: number;
  primaryOk: boolean;
  shadowOk: boolean;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlJson(obj: Record<string, unknown>): string {
  return base64url(Buffer.from(JSON.stringify(obj)));
}

/** Decode the payload of a JWT minted by mintTenantJwt. Test/inspection only. */
export function decodeTenantJwt(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const payloadEnc = parts[1] ?? "";
  try {
    const padded = payloadEnc.padEnd(
      payloadEnc.length + ((4 - (payloadEnc.length % 4)) % 4),
      "="
    );
    const buf = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface RlsJwt {
  /** Resolve the current RLS stage. Defaults to 1 when unset/invalid. Cached. */
  getRlsStage(): RlsStage;
  /** Test/ops: clear the cached stage so the stage source is re-read. */
  _resetRlsStageCache(): void;
  /** Mint a PostgREST-compatible HS256 JWT scoped to a tenant. */
  mintTenantJwt(tenantId: string, opts?: MintTenantJwtOptions): string;
  /** Headers carrying a tenant-scoped JWT instead of service_role. */
  tenantScopedHeaders(tenantId: string, opts?: MintTenantJwtOptions): Record<string, string>;
  /** Subscribe to shadow comparison results (one subscriber, last writer wins). */
  onRlsShadowDiff(cb: (d: RlsShadowDiff) => void): void;
  _resetShadowSubscriber(): void;
  /**
   * Stage 2 helper. Run the primary query (service_role) and a shadow query
   * (tenant-JWT) in parallel. Compare row counts. Log mismatches as WARNING.
   *
   * Returns the primary result so shadow failures never block production.
   * Stage 1 skips the shadow entirely. Stage 3 inverts: shadow becomes primary
   * upstream (callers select headers via `getRlsStage()`), so this helper is a
   * no-op there.
   */
  runWithRlsShadow<TRow>(
    fn: string,
    primary: () => Promise<{ ok: boolean; rows: TRow[] }>,
    shadow: () => Promise<{ ok: boolean; rows: TRow[] }>
  ): Promise<{ ok: boolean; rows: TRow[] }>;
}

/**
 * Create an RLS-JWT helper bound to injected sources.
 * インスタンスごとに stage キャッシュと shadow subscriber を持つ。
 */
export function createRlsJwt(sources: RlsJwtSources): RlsJwt {
  const warn =
    sources.warn ??
    ((entry: Record<string, unknown>) => console.warn(JSON.stringify(entry)));
  const now = sources.now ?? Date.now;

  let _cachedStage: RlsStage | null = null;
  let _shadowSubscriber: ((d: RlsShadowDiff) => void) | null = null;

  function getRlsStage(): RlsStage {
    if (_cachedStage !== null) return _cachedStage;
    // Canary promotion rotates the stage without a process restart; the source
    // is read lazily and cached via _cachedStage.
    const raw = (sources.stage ? sources.stage() : undefined) || "1";
    const n = parseInt(raw, 10);
    _cachedStage = (n === 2 || n === 3 ? n : 1) as RlsStage;
    return _cachedStage;
  }

  function _resetRlsStageCache(): void {
    _cachedStage = null;
  }

  function mintTenantJwt(tenantId: string, opts: MintTenantJwtOptions = {}): string {
    // Secret rotation must take effect without a process restart; read per call.
    const secret = sources.jwtSecret() || "";
    if (!secret) {
      throw new Error(
        "mintTenantJwt requires a JWT secret (RLS Stage 2/3 prerequisite)"
      );
    }
    if (!tenantId) {
      throw new Error("mintTenantJwt requires a non-empty tenantId");
    }
    const role = opts.role || "authenticated";
    const expSec = opts.expSec ?? 300;
    const nowSec = Math.floor(now() / 1000);

    const header = { alg: "HS256", typ: "JWT" };
    const payload: Record<string, unknown> = {
      role,
      tenant_id: tenantId,
      iat: nowSec,
      exp: nowSec + expSec,
    };
    if (opts.sub) payload.sub = opts.sub;

    const headerEnc = base64urlJson(header);
    const payloadEnc = base64urlJson(payload);
    const data = `${headerEnc}.${payloadEnc}`;
    const sig = base64url(createHmac("sha256", secret).update(data).digest());
    return `${data}.${sig}`;
  }

  function tenantScopedHeaders(
    tenantId: string,
    opts: MintTenantJwtOptions = {}
  ): Record<string, string> {
    const jwt = mintTenantJwt(tenantId, opts);
    // Runtime read for parity with mintTenantJwt; caching would defeat rotation.
    const apikey = (sources.apiKey ? sources.apiKey() : undefined) || "";
    return {
      apikey,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    };
  }

  function onRlsShadowDiff(cb: (d: RlsShadowDiff) => void): void {
    _shadowSubscriber = cb;
  }

  function _resetShadowSubscriber(): void {
    _shadowSubscriber = null;
  }

  async function runWithRlsShadow<TRow>(
    fn: string,
    primary: () => Promise<{ ok: boolean; rows: TRow[] }>,
    shadow: () => Promise<{ ok: boolean; rows: TRow[] }>
  ): Promise<{ ok: boolean; rows: TRow[] }> {
    const stage = getRlsStage();
    if (stage !== 2) return primary();

    const t0 = now();
    const [primaryRes, shadowRes] = await Promise.all([
      primary().catch((e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        warn({ severity: "WARNING", message: "rls_shadow_primary_threw", fn, error });
        return { ok: false, rows: [] as TRow[] };
      }),
      shadow().catch((e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        warn({ severity: "WARNING", message: "rls_shadow_shadow_threw", fn, error });
        return { ok: false, rows: [] as TRow[] };
      }),
    ]);
    const ms = now() - t0;

    const diff: RlsShadowDiff = {
      fn,
      primaryCount: primaryRes.rows.length,
      shadowCount: shadowRes.rows.length,
      match:
        primaryRes.ok === shadowRes.ok &&
        primaryRes.rows.length === shadowRes.rows.length,
      ms,
      primaryOk: primaryRes.ok,
      shadowOk: shadowRes.ok,
    };
    if (!diff.match) {
      warn({ severity: "WARNING", message: "rls_shadow_mismatch", ...diff });
    }
    if (_shadowSubscriber) {
      try {
        _shadowSubscriber(diff);
      } catch {
        /* observer must not break primary */
      }
    }
    return primaryRes;
  }

  return {
    getRlsStage,
    _resetRlsStageCache,
    mintTenantJwt,
    tenantScopedHeaders,
    onRlsShadowDiff,
    _resetShadowSubscriber,
    runWithRlsShadow,
  };
}
