/**
 * @torihanaku/auth-session — cookie session + HMAC-signed token machinery.
 *
 * Ported from 実運用SaaS (server/lib/auth.ts + server/lib/token.ts) with
 * product coupling (Supabase, env reads, Hono, E2E bypass env gates) removed via
 * config injection.
 */
export {
  createTokenService,
  timingSafeEqualStr,
  type TokenService,
  type TokenConfig,
  type SessionStore,
  type SessionRecord,
  type InvitePayload,
  type LogFn,
} from "./token";

export {
  createAuthService,
  getSecureOrigin,
  type AuthService,
  type AuthConfig,
  type BearerResolver,
  type RoleResolver,
  type Role,
} from "./auth";
