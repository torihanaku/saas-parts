/**
 * Token/crypto operations: HMAC signing, AES-GCM encryption, session cookie creation,
 * and invitation token helpers.
 *
 * Pure crypto — no HTTP, no DB lookups. Persistence of server-side sessions is
 * pluggable via the {@link SessionStore} interface (the original implementation
 * wrote to a Supabase `sessions` table; here the caller injects the store).
 *
 * Security properties (preserved from the original):
 * - Timing-safe comparison to prevent timing attacks (crypto.timingSafeEqual)
 * - No backward-compatible 16-char signature acceptance
 * - Token expiry enforced by callers via the embedded expiry timestamp
 * - Uses Node.js crypto (compatible with both Bun and Node/vitest)
 *
 * Configuration note: the secret MUST be provided via {@link TokenConfig.secret}.
 * This library never reads process.env — in the original app the value came from
 * the SESSION_SECRET environment variable; read it in your composition root and
 * pass it in.
 *
 * 出典: dev-dashboard-v2/server/lib/token.ts
 */
import {
  createHmac,
  timingSafeEqual as cryptoTimingSafeEqual,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";

const DEFAULT_COOKIE_NAME = "session";
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const INVITE_TOKEN_VERSION = "i1";
const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Structured log sink (original used console.warn with JSON). Default: no-op. */
export type LogFn = (entry: Record<string, unknown>) => void;

/** A server-side session row (original: Supabase `sessions` table). */
export interface SessionRecord {
  id: string;
  email: string;
  expiresAt: Date;
}

/**
 * Pluggable server-side session persistence.
 *
 * `createSession` returns true when the row was stored (original: `res.ok` on the
 * PostgREST insert). Returning false or throwing makes `createSessionCookie` fall
 * back to an email-in-token so the user still gets a working session at the cost
 * of no server-side invalidation.
 */
export interface SessionStore {
  createSession(session: SessionRecord): Promise<boolean>;
  getSession(id: string): Promise<{ email: string; expiresAt: Date } | null>;
}

export interface TokenConfig {
  /** HMAC/encryption secret. Required, non-empty. (was: env SESSION_SECRET) */
  secret: string;
  /** Session cookie name. Default: "session". */
  cookieName?: string;
  /** Session token lifetime in ms. Default: 7 days. */
  sessionTtlMs?: number;
  /** Invite token lifetime in ms. Default: 7 days. */
  inviteTtlMs?: number;
  /** Optional server-side session persistence (was: Supabase `sessions` table). */
  sessionStore?: SessionStore;
  /**
   * Identity embedded in the fallback token when createSessionCookie() is called
   * with no email (dev / no-store mode). Defaults to "admin" for source parity —
   * override with a NON-privileged value (or your own guard) in production so a
   * no-arg call can't mint a privileged session.
   */
  fallbackIdentity?: string;
  /** Structured warning logger. Default: no-op. */
  logger?: LogFn;
}

export interface InvitePayload {
  email: string;
  role: string;
  expiresAt: number;
}

/** Timing-safe string comparison using Node.js crypto */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return cryptoTimingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Create a token service bound to a secret.
 * All functions preserve the original token format:
 *   signed token  = encrypt(data) + "." + hmacSha256Hex(encrypt(data)).slice(0, 32)
 *   encrypt(data) = ivHex:authTagHex:ciphertextHex (AES-256-GCM)
 */
export function createTokenService(config: TokenConfig) {
  const COOKIE_SECRET = config.secret;
  if (!COOKIE_SECRET) {
    throw new Error("auth-session: config.secret must be a non-empty string");
  }
  const cookieName = config.cookieName ?? DEFAULT_COOKIE_NAME;
  const sessionTtlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const inviteTtlMs = config.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS;
  const sessionStore = config.sessionStore;
  const fallbackIdentity = config.fallbackIdentity ?? "admin";
  const logger: LogFn = config.logger ?? (() => {});

  // Derive encryption key from cookie secret
  const ENCRYPTION_KEY = createHmac("sha256", COOKIE_SECRET).update("encryption-key").digest();

  /** Encrypt a string and return iv:authTag:ciphertext */
  function encrypt(text: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");
    return `${iv.toString("hex")}:${authTag}:${encrypted}`;
  }

  /** Decrypt a string format iv:authTag:ciphertext */
  function decrypt(text: string): string | null {
    try {
      const [ivHex, authTagHex, encrypted] = text.split(":");
      if (!ivHex || !authTagHex || !encrypted) return null;
      const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY, Buffer.from(ivHex, "hex"));
      decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
      let decrypted = decipher.update(encrypted, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch {
      return null;
    }
  }

  /** Sign a data string with HMAC-SHA256, producing data.signature */
  function signToken(data: string): string {
    const opaqueData = encrypt(data);
    const hmac = createHmac("sha256", COOKIE_SECRET);
    hmac.update(opaqueData);
    return opaqueData + "." + hmac.digest("hex").substring(0, 32);
  }

  /**
   * Verify a signed token using timing-safe comparison.
   * NOTE: this checks the SIGNATURE ONLY — it does not enforce the embedded
   * expiry. Prefer {@link verifySessionToken} for session cookies so an expired
   * (but still correctly-signed) token is rejected.
   */
  function verifyToken(token: string): boolean {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return false;
    const opaqueData = token.substring(0, dotIdx);
    const sig = token.substring(dotIdx + 1);
    const hmac = createHmac("sha256", COOKIE_SECRET);
    hmac.update(opaqueData);
    const expected = hmac.digest("hex").substring(0, 32);
    return timingSafeEqualStr(expected, sig);
  }

  /**
   * Verify signature AND enforce the embedded expiry for a session token.
   * Returns the decrypted payload (`session:{id}:{expires}` or
   * `auth:{identity}:{expires}`) when valid, or null when the signature is bad,
   * the ciphertext is tampered, or the token has expired.
   */
  function verifySessionToken(token: string): string | null {
    if (!verifyToken(token)) return null;
    const dotIdx = token.lastIndexOf(".");
    const data = decrypt(token.substring(0, dotIdx));
    if (!data) return null;
    // The expiry is the trailing numeric segment; identity/id carry no colons.
    const parts = data.split(":");
    const expires = Number(parts[parts.length - 1]);
    if (!Number.isFinite(expires) || Date.now() > expires) return null;
    return data;
  }

  /**
   * Create a session cookie token (default 7-day expiry).
   *
   * If a SessionStore is configured, inserts a session row and returns a
   * UUID-based opaque token. If the insert fails (createSession returns false or
   * throws), falls back to an email-in-token so the user still gets a working
   * session at the cost of no server-side invalidation.
   *
   * Falls back to email-in-token immediately when no SessionStore is configured
   * (dev / no-DB mode). When email is not provided, uses "admin" as the identity.
   *
   * NOTE (from the original): `getSessionEmail` reads the same store, so the two
   * MUST point at the same table/backend. Writing to a non-existent table caused
   * every subsequent auth check to fail for SAML/OAuth logins (Issue #736).
   */
  async function createSessionCookie(email?: string): Promise<string> {
    const expires = Date.now() + sessionTtlMs;
    const identity = email || fallbackIdentity;

    if (email && sessionStore) {
      const sessionId = randomUUID();
      try {
        const ok = await sessionStore.createSession({
          id: sessionId,
          email,
          expiresAt: new Date(expires),
        });
        if (ok) {
          return signToken(`session:${sessionId}:${expires}`);
        }
        logger({
          severity: "WARNING",
          message: "createSessionCookie insert failed, falling back to embedded token",
        });
      } catch {
        // Store error — fall through to email-in-token
      }
    }
    // Fallback: embed identity directly in token (dev, no store, or insert failure)
    return signToken(`auth:${identity}:${expires}`);
  }

  /** Format a consistent, secure Set-Cookie string for session cookies. */
  function formatSessionCookie(sessionId: string): string {
    const maxAge = Math.floor(sessionTtlMs / 1000);
    return `${cookieName}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
  }

  // --- Invitation token helpers ---

  /**
   * Generate a self-contained, HMAC-signed invitation token.
   * Format: base64url(version:email:role:expiresAt).signature
   */
  function createInviteToken(email: string, role: string): string {
    const expiresAt = Date.now() + inviteTtlMs;
    const payload = Buffer.from(`${INVITE_TOKEN_VERSION}:${email}:${role}:${expiresAt}`).toString("base64url");
    const hmac = createHmac("sha256", COOKIE_SECRET + ":invite");
    hmac.update(payload);
    const sig = hmac.digest("hex").substring(0, 32);
    return `${payload}.${sig}`;
  }

  /**
   * Verify and decode an invitation token.
   * Returns the payload if valid, or null if invalid/expired.
   */
  function verifyInviteToken(token: string): InvitePayload | null {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return null;

    const payload = token.substring(0, dotIdx);
    const sig = token.substring(dotIdx + 1);

    const hmac = createHmac("sha256", COOKIE_SECRET + ":invite");
    hmac.update(payload);
    const expected = hmac.digest("hex").substring(0, 32);
    if (!timingSafeEqualStr(expected, sig)) return null;

    try {
      const decoded = Buffer.from(payload, "base64url").toString("utf8");
      const parts = decoded.split(":");
      if (parts.length !== 4 || parts[0] !== INVITE_TOKEN_VERSION) return null;
      const email = parts[1];
      const role = parts[2];
      const expiresAt = parseInt(parts[3] ?? "");
      if (isNaN(expiresAt) || Date.now() > expiresAt) return null;
      if (!email || !role) return null;
      return { email, role, expiresAt };
    } catch {
      return null;
    }
  }

  return {
    cookieName,
    encrypt,
    decrypt,
    signToken,
    verifyToken,
    verifySessionToken,
    createSessionCookie,
    formatSessionCookie,
    createInviteToken,
    verifyInviteToken,
  };
}

export type TokenService = ReturnType<typeof createTokenService>;
