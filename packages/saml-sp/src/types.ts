/**
 * Local type definitions for @torihanaku/saml-sp.
 *
 * `IdpConfig` is the ported shape of the original `SsoConfiguration` row
 * (dev-dashboard-v2 `server/lib/supabase.ts`). Persistence coupling is
 * removed: instead of reading from a database, callers inject the config
 * (or an `IdpConfigStore`) themselves. ACS URL, SP entity ID, and IdP cert
 * are all fields on this config — nothing is read from process.env.
 */

/** SAML/OIDC provider configuration, injected by the caller. */
export interface IdpConfig {
  id: string;
  tenant_id?: string | null;
  provider_name: string;
  protocol: "saml" | "oidc";
  enabled: boolean;
  created_at: string;
  updated_at: string;
  /** Maps logical claim names (e.g. "email") to SAML attribute names. */
  attribute_mapping: Record<string, string>;
  // OIDC-era fields kept optional so mixed-provider stores keep working.
  metadata_url?: string;
  client_id?: string;
  client_secret?: string;
  issuer?: string;
  callback_url?: string;
  // SAML 2.0 fields.
  /** IdP EntityID (Issuer the IdP stamps on assertions). */
  idp_entity_id?: string;
  /** IdP Single Sign-On URL (HTTP-Redirect binding entry point). */
  idp_sso_url?: string;
  /** IdP signing certificate (PEM or bare base64 body). */
  idp_x509_cert?: string;
  /** Our SP EntityID — also used as the expected Audience. */
  sp_entity_id?: string;
  /** Our Assertion Consumer Service URL (HTTP-POST binding). */
  sp_acs_url?: string;
  sign_requests?: boolean;
  want_assertions_signed?: boolean;
}

/**
 * Injected store replacing the original Supabase persistence.
 * Implement `get` against whatever backend you use (SQL row, KV, config
 * file, in-memory map). `save` is optional — only needed if you use this
 * package's helpers to write configs back.
 */
export interface IdpConfigStore {
  get(tenantId: string): Promise<IdpConfig | null>;
  save?(config: IdpConfig): Promise<boolean>;
}

/**
 * Normalised SAML assertion returned to the caller after validation.
 * Ported from dev-dashboard-v2 `shared/types/sso.ts`.
 */
export interface SamlAssertion {
  /** The NameID from the Subject element (typically the user's email or a persistent ID). */
  nameId: string;
  /** Issuer element — must match the configured `idp_entity_id`. */
  issuer: string;
  /** Audience restriction — must match the configured `sp_entity_id`. */
  audience: string;
  /** Session index, used for optional single logout. */
  sessionIndex?: string;
  /** Raw attribute statements keyed by attribute Name. */
  attributes: Record<string, string | string[]>;
  /** ISO timestamp when the assertion was issued. */
  issuedAt: string;
  /** ISO timestamp when the assertion stops being valid. */
  notOnOrAfter: string;
}
