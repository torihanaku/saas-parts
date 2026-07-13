/**
 * Tenant management: resolve or create tenants for the current request.
 *
 * 移植元: 実運用SaaS server/lib/tenant.ts (分割元: server/lib/auth.ts, Issue #641)
 *
 * #952 hardening (2026-04-20): The previous implementation silently swallowed every
 * storage error, returning `null` from `getOrCreateDefaultTenant()` whenever the
 * default tenant didn't exist or the create call failed. Callers then surfaced
 * "Tenant not resolved" 401 across ~8 admin pages with zero diagnostic signal.
 *
 * Changes preserved from the original:
 *   1. Log storage failures so we can tell *why* the lookup failed.
 *   2. Cache the resolved default-tenant UUID (per resolver instance) so we don't
 *      hammer the backing store on every hot-path request.
 *   3. Fall back to a static `slug='admin'` lookup when adminEmail is empty or
 *      the literal sentinel "admin".
 *   4. Resolve members by team-member email first, then default-tenant fallback
 *      (preserves prior behaviour for unmapped emails).
 *   5. Backfill: when a team-member row exists but its tenant_id is NULL, look up
 *      a tenant by owner email / email domain before falling through to the
 *      default tenant (#952 hotfix).
 *
 * 依存の切り離し:
 *   - Supabase (dashboard_team_members / tenants テーブル) への参照 → `TenantStore`
 *   - セッション email の取得 (getSessionEmail) → 注入コールバック
 *   - env.ADMIN_EMAIL → options.adminEmail
 */

export const DEFAULT_ADMIN_SLUG = "admin";

/** dashboard_team_members 相当の行 (email 検索結果)。行が無い場合は null。 */
export interface TenantMemberRow {
  tenant_id: string | null;
}

/** tenants 相当の新規作成入力 (元実装の POST body をミラー)。 */
export interface CreateTenantInput {
  name: string;
  slug: string;
  owner_email: string;
  plan: string;
  is_active: boolean;
}

/**
 * ストレージ抽象。元実装の Supabase REST クエリを 1:1 でメソッドに写像:
 *   - findMemberByEmail      … dashboard_team_members?email=eq.{email}&select=tenant_id&limit=1
 *   - findTenantByOwnerEmail … tenants?owner_email=eq.{email}&select=id&limit=1
 *   - findTenantBySlug       … tenants?slug=eq.{slug}&select=id&limit=1
 *   - findTenantByDomain     … tenants?owner_email=like.*@{domain}&limit=1&order=created_at.asc
 *   - createTenant           … POST tenants (Prefer: return=representation) → id
 *
 * 各メソッドは「見つからない」= null を返す。異常 (ネットワーク等) は throw してよい —
 * リゾルバ側が捕捉して警告ログを出し、元実装と同じフォールバック順で継続する。
 */
export interface TenantStore {
  findMemberByEmail(email: string): Promise<TenantMemberRow | null>;
  findTenantByOwnerEmail(email: string): Promise<string | null>;
  findTenantBySlug(slug: string): Promise<string | null>;
  findTenantByDomain(domain: string): Promise<string | null>;
  createTenant(input: CreateTenantInput): Promise<string | null>;
}

export type TenantWarnLogger = (message: string, extra?: Record<string, unknown>) => void;

/** 元実装の logTenantWarn (構造化 JSON を console.warn) と同等のデフォルト。 */
export function defaultTenantWarnLogger(message: string, extra?: Record<string, unknown>): void {
  console.warn(JSON.stringify({ severity: "WARNING", message, ...extra }));
}

export interface TenantResolverOptions<TReq = unknown> {
  store: TenantStore;
  /** リクエストからセッション email を取り出すコールバック (元: getSessionEmail from auth.ts)。 */
  getSessionEmail: (req: TReq) => Promise<string | null> | string | null;
  /** システムオーナーの email (元: env.ADMIN_EMAIL)。未設定なら "admin" センチネル運用。 */
  adminEmail?: string;
  /** 警告ロガー (デフォルト: JSON を console.warn)。 */
  logWarn?: TenantWarnLogger;
}

export interface TenantResolver<TReq = unknown> {
  /**
   * Get or create the default tenant for the system owner.
   *
   * Resolution order:
   *   1. cached value (per-resolver instance)
   *   2. tenants WHERE owner_email = adminEmail (if set)
   *   3. tenants WHERE slug = 'admin' (fallback so it works without adminEmail)
   *   4. create a fresh tenant with owner_email = adminEmail || 'admin'
   *   5. slug='admin' retry (create race)
   */
  getOrCreateDefaultTenant(): Promise<string | null>;
  /**
   * Resolve the tenant_id for the current request's user.
   * Looks up the team member by email and returns their tenant_id.
   * Falls back to getOrCreateDefaultTenant for system admin / unmapped users.
   */
  getTenantId(req: TReq): Promise<string | null>;
  /** Reset the cached default-tenant id (for tests). */
  resetDefaultTenantCache(): void;
}

export function createTenantResolver<TReq = unknown>(
  options: TenantResolverOptions<TReq>,
): TenantResolver<TReq> {
  const { store, getSessionEmail } = options;
  const adminEmail = options.adminEmail || "";
  const logWarn = options.logWarn ?? defaultTenantWarnLogger;

  let cachedDefaultTenantId: string | null = null;

  async function fetchTenantIdByOwner(email: string): Promise<string | null> {
    try {
      return await store.findTenantByOwnerEmail(email);
    } catch (e: unknown) {
      logWarn("tenant: owner_email lookup threw", {
        owner_email: email,
        error: (e as Error).message,
      });
      return null;
    }
  }

  async function fetchTenantIdBySlug(slug: string): Promise<string | null> {
    try {
      return await store.findTenantBySlug(slug);
    } catch (e: unknown) {
      logWarn("tenant: slug lookup threw", { slug, error: (e as Error).message });
      return null;
    }
  }

  async function createDefaultTenant(ownerEmail: string, slug: string): Promise<string | null> {
    try {
      // NOTE: 元実装の `tenants` テーブルには `type` カラムが無い。`tenant.type === 'agency'`
      // の区別はアプリ層で行う (agency-access パッケージ参照)。ここで type を送ると
      // PostgREST が 4xx を返して create パスが静かに失敗した (#952 hotfix 2026-04-20)。
      return await store.createTenant({
        name: ownerEmail === "admin" ? "Default" : ownerEmail.split("@")[0] ?? "Default",
        slug,
        owner_email: ownerEmail,
        plan: "free",
        is_active: true,
      });
    } catch (e: unknown) {
      logWarn("tenant: create threw", {
        owner_email: ownerEmail,
        slug,
        error: (e as Error).message,
      });
      return null;
    }
  }

  /**
   * Best-effort: backfill `tenant_id` for a team-member row that has the column NULL
   * by looking up the tenant whose owner email matches the user's email (or domain).
   * Avoids the silent fall-through to default tenant when the user already has a
   * tenant but their team-member row hasn't been linked yet (#952 hotfix).
   */
  async function findTenantByEmailOrDomain(email: string): Promise<string | null> {
    // Try owner_email exact match first.
    try {
      const exact = await store.findTenantByOwnerEmail(email);
      if (exact) return exact;
    } catch {
      /* fall through */
    }
    // Then try by email domain match against any tenant owner with the same domain.
    const domain = email.split("@")[1];
    if (!domain) return null;
    try {
      const byDomain = await store.findTenantByDomain(domain);
      if (byDomain) return byDomain;
    } catch {
      /* fall through */
    }
    return null;
  }

  async function getOrCreateDefaultTenant(): Promise<string | null> {
    if (cachedDefaultTenantId) return cachedDefaultTenantId;

    const ownerEmail = adminEmail || "admin";
    const slugFromEmail =
      ownerEmail
        .split("@")[0]!
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-") || DEFAULT_ADMIN_SLUG;

    // (2) by owner_email
    if (adminEmail) {
      const byOwner = await fetchTenantIdByOwner(adminEmail);
      if (byOwner) {
        cachedDefaultTenantId = byOwner;
        return byOwner;
      }
    }

    // (3) by slug='admin' (works even without adminEmail)
    const bySlug = await fetchTenantIdBySlug(DEFAULT_ADMIN_SLUG);
    if (bySlug) {
      cachedDefaultTenantId = bySlug;
      return bySlug;
    }

    // (4) create
    const created = await createDefaultTenant(ownerEmail, slugFromEmail);
    if (created) {
      cachedDefaultTenantId = created;
      return created;
    }

    // Last-ditch: try slug='admin' once more in case of race
    const retry = await fetchTenantIdBySlug(DEFAULT_ADMIN_SLUG);
    if (retry) {
      cachedDefaultTenantId = retry;
      return retry;
    }

    logWarn("tenant: getOrCreateDefaultTenant exhausted all paths", {
      admin_email_set: Boolean(adminEmail),
    });
    return null;
  }

  async function getTenantId(req: TReq): Promise<string | null> {
    const email = await getSessionEmail(req);
    if (!email || email === "admin") return getOrCreateDefaultTenant();

    try {
      const member = await store.findMemberByEmail(email);
      if (member) {
        if (member.tenant_id) return member.tenant_id;
        // Member row exists but tenant_id is NULL — try to find a tenant by
        // owner email or domain so we don't silently fall through to the default
        // and trap legitimate users on the wrong tenant (#952 hotfix).
        const linkable = await findTenantByEmailOrDomain(email);
        if (linkable) return linkable;
      }
    } catch (e: unknown) {
      logWarn("tenant: team_members lookup threw", {
        email,
        error: (e as Error).message,
      });
    }
    // Admin email also falls back to default tenant.
    return getOrCreateDefaultTenant();
  }

  return {
    getOrCreateDefaultTenant,
    getTenantId,
    resetDefaultTenantCache(): void {
      cachedDefaultTenantId = null;
    },
  };
}

// ─── Request guards ──────────────────────────────────────────────────────────

/**
 * Require a resolved tenant_id. Throws if unresolvable.
 * ミドルウェア等で req に事前設定された `tenantId` を読む (元実装と同じ契約)。
 */
export function requireTenant(req: object): string {
  const tenantId = (req as { tenantId?: string | null }).tenantId;
  if (!tenantId) {
    throw new Error("Tenant not resolved");
  }
  return tenantId;
}

/**
 * Require a resolved user_id. Throws if unresolvable.
 */
export function requireUser(req: object): string {
  const userId = (req as { userId?: string | null }).userId;
  if (!userId) {
    throw new Error("User not authenticated");
  }
  return userId;
}
