/**
 * OAuth flow manager — generic provider-agnostic OAuth 2.0 flow.
 *
 * Builds on `oauth-state.ts` (CSRF nonce management) and adds:
 *   - Provider configuration via injected config objects
 *   - Authorization URL construction (optionally with PKCE / S256)
 *   - Token exchange
 *   - Token refresh
 *   - Connection persistence via an injected ConnectionStore
 *
 * Ported from 実運用SaaS/server/lib/oauth-manager.ts with product
 * coupling removed:
 *   - Supabase helpers → injected `ConnectionStore` (in-memory default)
 *   - Redis-backed oauth-state → injected `StateStore` (in-memory default)
 *   - `fetchWithTimeout` helper → inlined (global fetch + AbortController),
 *     fetch implementation injectable for tests
 *   - `env.*` reads in provider factories → caller-supplied credentials
 *
 * Usage:
 *   import { OAuthManager } from "@torihanaku/oauth-manager";
 *   const manager = new OAuthManager("slack", slackConfig);
 *   const { url, state } = await manager.buildAuthUrl(redirectUri);
 *   // …redirect user to `url`…
 *   const token = await manager.exchangeCode(code, state, redirectUri);
 *   await manager.saveConnection(userId, token);
 */

import { createHash, randomBytes } from "node:crypto";
import { generateOAuthState, consumeOAuthState, type StateStore } from "./oauth-state";
import { InMemoryConnectionStore, type ConnectionStore } from "./connection-store";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OAuthProviderConfig {
  /** OAuth 2.0 authorization endpoint */
  authorizationUrl: string;
  /** Token exchange endpoint */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated scopes */
  scope?: string;
  /** Extra query params for the authorization URL */
  extraAuthParams?: Record<string, string>;
  /** Enable PKCE (RFC 7636, S256). Adds code_challenge to the auth URL and
   * code_verifier to the token exchange. */
  usePkce?: boolean;
}

export interface OAuthToken {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  /** Provider-specific metadata (team, user, org, …) */
  metadata?: Record<string, unknown>;
}

export interface OAuthConnection {
  id: string;
  provider: string;
  user_id: string;
  access_token: string;
  refresh_token?: string;
  scope?: string;
  metadata?: Record<string, unknown>;
  status: "active" | "revoked" | "expired";
  created_at: string;
  updated_at: string;
}

type FetchLike = typeof fetch;

export interface OAuthManagerOptions {
  /** Table name passed to the ConnectionStore (default: oauth_connections) */
  table?: string;
  /** CSRF state nonce storage (default: shared in-memory store) */
  stateStore?: StateStore;
  /** Connection persistence backend (default: in-memory) */
  connectionStore?: ConnectionStore;
  /** fetch implementation (default: global fetch) */
  fetch?: FetchLike;
}

// ─── PKCE ────────────────────────────────────────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** Generate a PKCE code_verifier / S256 code_challenge pair (RFC 7636). */
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url"); // 43 chars, [A-Za-z0-9_-]
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

// ─── fetch helper (inlined from the product's helpers.ts) ────────────────────

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── OAuthManager class ───────────────────────────────────────────────────────

export class OAuthManager {
  private readonly table: string;
  private readonly stateStore: StateStore | undefined;
  private readonly connectionStore: ConnectionStore;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly provider: string,
    private readonly config: OAuthProviderConfig,
    options?: OAuthManagerOptions,
  ) {
    this.table = options?.table ?? "oauth_connections";
    this.stateStore = options?.stateStore; // undefined → oauth-state's default store
    this.connectionStore = options?.connectionStore ?? new InMemoryConnectionStore();
    this.fetchImpl = options?.fetch ?? fetch;
  }

  // ── Authorization URL ────────────────────────────────────────────────────

  /**
   * Build an authorization URL with a CSRF-safe state nonce.
   * Returns the URL to redirect the user to and the raw state string
   * (which must be passed back to `exchangeCode`).
   * When `usePkce` is enabled, the S256 code_challenge is attached and the
   * verifier is stored alongside the state nonce.
   */
  async buildAuthUrl(redirectUri: string): Promise<{ url: string; state: string }> {
    const pkce = this.config.usePkce ? generatePkce() : undefined;
    const state = await generateOAuthState(
      this.provider,
      this.stateStore,
      pkce ? { verifier: pkce.verifier } : undefined,
    );

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      ...(this.config.scope ? { scope: this.config.scope } : {}),
      ...(pkce ? { code_challenge: pkce.challenge, code_challenge_method: pkce.method } : {}),
      ...(this.config.extraAuthParams ?? {}),
    });

    return {
      url: `${this.config.authorizationUrl}?${params.toString()}`,
      state,
    };
  }

  // ── Token exchange ───────────────────────────────────────────────────────

  /**
   * Validate the CSRF state and exchange the authorization code for tokens.
   * Throws if state is invalid.
   */
  async exchangeCode(code: string, state: string, redirectUri: string): Promise<OAuthToken> {
    const { valid, verifier } = await consumeOAuthState(state, this.provider, this.stateStore);
    if (!valid) throw new Error(`Invalid or expired OAuth state for provider: ${this.provider}`);

    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      ...(verifier ? { code_verifier: verifier } : {}),
    });

    const res = await fetchWithTimeout(
      this.fetchImpl,
      this.config.tokenUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      15_000,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Token exchange failed (${res.status}): ${text}`);
    }

    return await res.json() as OAuthToken;
  }

  // ── Token refresh ────────────────────────────────────────────────────────

  /**
   * Use a refresh token to get a new access token.
   * Throws if the provider does not support refresh tokens or the request fails.
   */
  async refreshToken(refreshToken: string): Promise<OAuthToken> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const res = await fetchWithTimeout(
      this.fetchImpl,
      this.config.tokenUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      15_000,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }

    return await res.json() as OAuthToken;
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /** Save (insert) a new OAuth connection via the ConnectionStore. */
  async saveConnection(userId: string, token: OAuthToken): Promise<OAuthConnection> {
    const connection: OAuthConnection = {
      id: crypto.randomUUID(),
      provider: this.provider,
      user_id: userId,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      scope: token.scope,
      metadata: token.metadata,
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await this.connectionStore.insert(this.table, connection as unknown as Record<string, unknown>);
    return connection;
  }

  /** Update an existing connection's tokens (e.g., after refresh). */
  async updateConnection(connectionId: string, token: OAuthToken): Promise<boolean> {
    const result = await this.connectionStore.patch(
      this.table,
      `id=eq.${encodeURIComponent(connectionId)}`,
      {
        access_token: token.access_token,
        ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
        updated_at: new Date().toISOString(),
      },
    );
    return result.ok;
  }

  /** Revoke a connection (soft-delete by setting status="revoked"). */
  async revokeConnection(connectionId: string): Promise<boolean> {
    const result = await this.connectionStore.patch(
      this.table,
      `id=eq.${encodeURIComponent(connectionId)}`,
      { status: "revoked", updated_at: new Date().toISOString() },
    );
    return result.ok;
  }

  /** List active connections for a user. */
  async listConnections(userId: string): Promise<OAuthConnection[]> {
    const rows = await this.connectionStore.get(
      this.table,
      `user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(this.provider)}&status=eq.active&order=created_at.desc`,
    );
    return (rows ?? []) as unknown as OAuthConnection[];
  }

  /** Get a single connection by ID. */
  async getConnection(connectionId: string): Promise<OAuthConnection | null> {
    const rows = await this.connectionStore.get(
      this.table,
      `id=eq.${encodeURIComponent(connectionId)}&provider=eq.${encodeURIComponent(this.provider)}&limit=1`,
    );
    return (rows?.[0] as unknown as OAuthConnection) ?? null;
  }
}

// ─── Pre-built provider factories ─────────────────────────────────────────────

/** Client credentials supplied by the caller (e.g., read from the app's own
 * env layer — this package never reads process.env). */
export interface OAuthClientCredentials {
  clientId?: string;
  clientSecret?: string;
}

/** Create an OAuthManager for Slack using caller-supplied credentials. */
export function createSlackOAuthManager(
  credentials: OAuthClientCredentials,
  options?: OAuthManagerOptions,
): OAuthManager | null {
  const { clientId, clientSecret } = credentials;
  if (!clientId || !clientSecret) return null;

  return new OAuthManager("slack", {
    authorizationUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    clientId,
    clientSecret,
    scope: "channels:read,chat:write,users:read",
  }, options);
}

/** Create an OAuthManager for GitHub using caller-supplied credentials. */
export function createGitHubOAuthManager(
  credentials: OAuthClientCredentials,
  options?: OAuthManagerOptions,
): OAuthManager | null {
  const { clientId, clientSecret } = credentials;
  if (!clientId || !clientSecret) return null;

  return new OAuthManager("github", {
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientId,
    clientSecret,
    scope: "repo,read:user",
  }, options);
}
