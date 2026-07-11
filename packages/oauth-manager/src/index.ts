/**
 * @torihanaku/oauth-manager — generic provider-agnostic OAuth 2.0 flow
 * (authorization-code + PKCE S256, CSRF state, token exchange/refresh,
 * pluggable state & connection persistence).
 */

export {
  OAuthManager,
  generatePkce,
  createSlackOAuthManager,
  createGitHubOAuthManager,
  type OAuthProviderConfig,
  type OAuthToken,
  type OAuthConnection,
  type OAuthManagerOptions,
  type OAuthClientCredentials,
  type PkcePair,
} from "./oauth-manager";

export {
  generateOAuthState,
  verifyOAuthState,
  consumeOAuthState,
  InMemoryStateStore,
  STATE_TTL,
  type StateStore,
  type OAuthStateData,
} from "./oauth-state";

export {
  InMemoryConnectionStore,
  type ConnectionStore,
} from "./connection-store";
