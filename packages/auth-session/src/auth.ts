/**
 * Authentication module: cookie-based session auth with timing-safe token verification.
 *
 * Security properties (preserved from the original):
 * - Timing-safe comparison to prevent timing attacks (using crypto.timingSafeEqual)
 * - No backward-compatible 16-char signature acceptance
 * - Token expiry enforced
 * - Uses Node.js crypto (compatible with both Bun and Node/vitest)
 *
 * Decoupling notes (port of 実運用SaaS/server/lib/auth.ts):
 * - env reads (SESSION_SECRET / ADMIN_EMAIL / SUPABASE_*) → {@link AuthConfig}
 * - Supabase JWT Bearer verification (/auth/v1/user) → injected {@link BearerResolver};
 *   the 5-minute token cache with bounded size is preserved inside this module.
 * - dashboard_team_members role lookup + auto-insert → injected {@link RoleResolver}
 * - Supabase `sessions` table read/write → injected {@link SessionStore} (see token.ts)
 * - E2E bypass (env-gated header check) → injected `isBypassRequest` predicate
 * - Hono `requireAuth` middleware and Supabase-admin user-UUID helpers
 *   (getUserIdUuid / getAuthUserUuid) were NOT ported (product-specific wiring).
 *
 * Takes standard `Request` objects (WHATWG fetch API — available in Node 18+/Bun),
 * no framework types.
 *
 * 出典: 実運用SaaS/server/lib/auth.ts
 */
import { createTokenService, type SessionStore, type TokenConfig } from "./token";

export type Role = "admin" | "editor" | "viewer" | "member";

const VALID_ROLES: readonly string[] = ["admin", "editor", "viewer", "member"];

/**
 * Verifies an opaque Bearer token and returns the authenticated user's email,
 * or null when invalid. (Original: Supabase GET /auth/v1/user with service key.)
 * Results are cached by this module for `bearerCacheTtlMs`.
 */
export type BearerResolver = (token: string) => Promise<string | null>;

/**
 * Resolves (or creates) the role for a user email. Return null/unknown values to
 * fall back to the admin-email check. (Original: dashboard_team_members lookup
 * with auto-insert of new members.)
 */
export type RoleResolver = (email: string) => Promise<string | null>;

export interface AuthConfig extends TokenConfig {
  /** Super-admin email. Default: "" = no super admin. (was: env ADMIN_EMAIL) */
  adminEmail?: string;
  /** Bearer-token → email verification. Omit to disable Bearer auth. */
  bearerResolver?: BearerResolver;
  /** email → role resolution. Omit for adminEmail/member-only fallback. */
  roleResolver?: RoleResolver;
  /** Test/E2E full-auth bypass predicate. (was: server/lib/e2e-bypass.ts) */
  isBypassRequest?: (req: Request) => boolean;
  /** Bearer verification cache TTL in ms. Default: 5 minutes. */
  bearerCacheTtlMs?: number;
  /** Max entries in the Bearer verification cache. Default: 1000. */
  maxBearerCacheSize?: number;
}

const DEFAULT_TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_TOKEN_CACHE_SIZE = 1000;

const BYPASS_SENTINEL = "__e2e_bypass__";

// Role hierarchy: a higher role implicitly satisfies lower ones.
// Index 0 = lowest privilege.
const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  member: 1,
  editor: 2,
  admin: 3,
};

/** Get secure origin respecting X-Forwarded-Proto for HTTPS-terminating proxies (e.g. Cloud Run) */
export function getSecureOrigin(req: Request, url: URL): string {
  const proto = req.headers.get("X-Forwarded-Proto") || url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createAuthService(config: AuthConfig) {
  const tokens = createTokenService(config);
  const adminEmail = config.adminEmail ?? "";
  const sessionStore: SessionStore | undefined = config.sessionStore;
  const bearerResolver = config.bearerResolver;
  const roleResolver = config.roleResolver;
  const isBypassRequest = config.isBypassRequest;
  const TOKEN_CACHE_TTL = config.bearerCacheTtlMs ?? DEFAULT_TOKEN_CACHE_TTL;
  const MAX_TOKEN_CACHE_SIZE = config.maxBearerCacheSize ?? DEFAULT_MAX_TOKEN_CACHE_SIZE;
  const cookiePattern = new RegExp(`${escapeRegExp(tokens.cookieName)}=([^;]+)`);

  /** Extract session token from request cookie, or null */
  function extractSessionToken(req: Request): string | null {
    if (isBypassRequest && isBypassRequest(req)) {
      return BYPASS_SENTINEL;
    }

    const cookie = req.headers.get("Cookie") || "";
    const match = cookie.match(cookiePattern);
    if (!match) return null;
    const token = match[1];
    if (!token || !tokens.verifyToken(token)) return null;
    return token;
  }

  /** Parse token data into parts.
   * Formats supported:
   *   session:{uuid}:{expires}  — UUID-based (email in session store)
   *   auth:{email}:{expires}    — email-in-token (legacy / no-store fallback)
   *   auth:{expires}            — legacy no-email format */
  function parseTokenParts(token: string): { uuid: string | null; email: string | null; expires: number } {
    if (token === BYPASS_SENTINEL) return { uuid: null, email: "admin", expires: Infinity };

    const dotIdx = token.lastIndexOf(".");
    const opaqueData = dotIdx === -1 ? token : token.substring(0, dotIdx);
    const data = tokens.decrypt(opaqueData);
    if (!data) return { uuid: null, email: null, expires: 0 };

    const parts = data.split(":");
    if (parts[0] === "session" && parts.length >= 3) {
      return { uuid: parts[1] ?? null, email: null, expires: parseInt(parts[2] ?? "") };
    }
    if (parts.length >= 3) {
      return { uuid: null, email: parts[1] ?? null, expires: parseInt(parts[2] ?? "") };
    }
    if (parts.length >= 2) {
      return { uuid: null, email: null, expires: parseInt(parts[1] ?? "") };
    }
    return { uuid: null, email: null, expires: 0 };
  }

  // --- Bearer token verification (resolver-backed, with bounded cache) ---

  const tokenCache = new Map<string, { email: string; expires: number }>();

  function setTokenCache(token: string, value: { email: string; expires: number }): void {
    const now = Date.now();
    for (const [k, v] of tokenCache) {
      if (now >= v.expires) tokenCache.delete(k);
    }
    while (tokenCache.size >= MAX_TOKEN_CACHE_SIZE) {
      const oldestKey = tokenCache.keys().next().value;
      if (!oldestKey) break;
      tokenCache.delete(oldestKey);
    }
    tokenCache.set(token, value);
  }

  async function verifyBearerToken(token: string): Promise<string | null> {
    const cached = tokenCache.get(token);
    if (cached && Date.now() < cached.expires) return cached.email;

    if (!bearerResolver) return null;

    try {
      const email = await bearerResolver(token);
      if (!email) return null;

      setTokenCache(token, { email, expires: Date.now() + TOKEN_CACHE_TTL });
      return email;
    } catch {
      return null;
    }
  }

  function extractBearerToken(req: Request): string | null {
    const auth = req.headers.get("Authorization") || "";
    return auth.startsWith("Bearer ") ? auth.slice(7) : null;
  }

  /** Check if request is authenticated via session cookie, Bearer token, or bypass. */
  async function checkAuth(req: Request): Promise<boolean> {
    const token = extractSessionToken(req);
    if (token) {
      const { expires } = parseTokenParts(token);
      if (Date.now() <= expires) return true;
    }
    const bearer = extractBearerToken(req);
    if (bearer) {
      const email = await verifyBearerToken(bearer);
      return email !== null;
    }
    return false;
  }

  /** Get the email of the authenticated user. */
  async function getSessionEmail(req: Request): Promise<string | null> {
    const token = extractSessionToken(req);
    if (token) {
      const { uuid, email, expires } = parseTokenParts(token);
      if (Date.now() <= expires) {
        if (uuid) {
          if (sessionStore) {
            try {
              const row = await sessionStore.getSession(uuid);
              if (row && row.expiresAt >= new Date()) {
                return row.email;
              }
            } catch { /* fall through to Bearer check */ }
          }
        } else if (email) {
          return email;
        }
      }
    }

    const bearer = extractBearerToken(req);
    if (bearer) return verifyBearerToken(bearer);

    return null;
  }

  /**
   * Look up a member's role by email via the injected RoleResolver. When no
   * resolver is configured (or it fails / returns an unknown role), falls back
   * to "admin" if the email matches adminEmail, otherwise "member".
   * (Original: dashboard_team_members lookup with auto-insert of new members —
   * the auto-insert now lives inside the caller-supplied resolver.)
   */
  async function getOrCreateMember(email: string): Promise<Role> {
    if (!roleResolver) {
      return email === adminEmail ? "admin" : "member";
    }
    try {
      const role = await roleResolver(email);
      if (role && VALID_ROLES.includes(role)) {
        return role as Role;
      }
      return email === adminEmail ? "admin" : "member";
    } catch {
      return email === adminEmail ? "admin" : "member";
    }
  }

  /** Get the current user's role. New/unmapped users default to "member". */
  async function getCurrentUserRole(req: Request): Promise<{ email: string; role: Role }> {
    const email = await getSessionEmail(req);
    if (!email || email === "admin") return { email: email || "admin", role: "admin" };
    const role = await getOrCreateMember(email);
    return { email, role };
  }

  /**
   * RBAC middleware: returns 403 Response if user lacks required role, or null if authorized.
   *
   * Hierarchy semantics: if any of the `allowed` roles is satisfied by the user's rank
   * (user's rank ≥ that allowed role's rank), the user is authorized. Without this,
   * `requireRole(req, "member")` used to 403 admin users (original issue #952).
   */
  async function requireRole(req: Request, ...allowed: Role[]): Promise<Response | null> {
    const { role } = await getCurrentUserRole(req);
    const userRank = ROLE_RANK[role] ?? -1;
    const minAllowedRank = Math.min(...allowed.map((r) => ROLE_RANK[r] ?? Infinity));
    if (userRank >= minAllowedRank) return null;
    return Response.json(
      { error: "この操作に必要な権限がありません", required: allowed, current: role },
      { status: 403 },
    );
  }

  /** Super Admin guard: adminEmail のユーザーのみ通過させる。 */
  async function requireSuperAdmin(req: Request): Promise<Response | null> {
    if (!adminEmail) {
      return Response.json({ error: "スーパー管理者が設定されていません" }, { status: 403 });
    }
    const email = await getSessionEmail(req);
    if (email === adminEmail) return null;
    return Response.json({ error: "スーパー管理者権限が必要です" }, { status: 403 });
  }

  return {
    // Token/session primitives (bound to the same secret/config)
    ...tokens,
    // Request-level auth
    checkAuth,
    getSessionEmail,
    getOrCreateMember,
    getCurrentUserRole,
    requireRole,
    requireSuperAdmin,
    /** Internal knobs exposed for tests (mirrors original __authTesting). */
    _testing: {
      tokenCache,
      setTokenCache,
      MAX_TOKEN_CACHE_SIZE,
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
