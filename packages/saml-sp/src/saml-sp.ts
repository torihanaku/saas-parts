/**
 * SAML 2.0 Service Provider wrapper.
 *
 * Ported from 実運用SaaS `server/lib/saml-sp.ts` (#110 / Epic G8).
 * Thin adapter around `@node-saml/node-saml` that turns an injected
 * `IdpConfig` into a `SAML` instance and exposes a small, typed surface
 * that the route layer can consume without knowing about XML DSig, Node
 * stream semantics, or caching internals.
 *
 * Why a wrapper instead of calling the library directly from routes:
 *   1. **Caching** — constructing a `SAML` instance validates the cert, so
 *      we memoise per `config.id + updated_at` to avoid repeating work on
 *      every request.
 *   2. **Error normalisation** — the library throws generic `Error` objects.
 *      We convert them into `SamlValidationError` with stable codes that
 *      the route layer can map onto HTTP responses and the UI can localise.
 *   3. **Profile → SamlAssertion** — the library returns a Passport-shaped
 *      `Profile` bag. We normalise it into the local `SamlAssertion` shape.
 *
 * Coupling changes vs. the original:
 *   - `SsoConfiguration` (Supabase row) → local `IdpConfig` type; the caller
 *     injects ACS URL / SP entity ID / IdP cert. No process.env reads.
 *   - Config persistence → injected `IdpConfigStore` (see `loadSamlConfig`).
 *
 * Usage:
 *   const url = await buildLoginRedirectUrl(config, relayState, host);
 *   const assertion = await validateSamlResponse(config, base64Response);
 */

import { SAML, type SamlConfig, type Profile } from "@node-saml/node-saml";
import type { IdpConfig, IdpConfigStore, SamlAssertion } from "./types";

/**
 * Stable error codes for SAML validation failures. The route layer maps
 * these to HTTP status codes and audit log entries.
 */
export type SamlErrorCode =
  | "missing_saml_response"
  | "invalid_signature"
  | "expired_assertion"
  | "audience_mismatch"
  | "issuer_mismatch"
  | "missing_name_id"
  | "missing_email"
  | "logged_out"
  | "unknown";

export class SamlValidationError extends Error {
  readonly code: SamlErrorCode;
  constructor(code: SamlErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SamlValidationError";
    this.code = code;
  }
}

/** Cached SAML instance keyed by `config.id` + `updated_at` to bust on edits. */
interface CachedInstance {
  key: string;
  saml: SAML;
}
const instanceCache = new Map<string, CachedInstance>();

/** Clear the SAML instance cache — call after a config write. */
export function clearSamlInstanceCache(configId?: string): void {
  if (configId) {
    instanceCache.delete(configId);
  } else {
    instanceCache.clear();
  }
}

/**
 * Resolve an enabled SAML configuration from an injected store, or null.
 * Replaces the original Supabase-backed `loadSamlConfig` route helper:
 * the store lookup is injected, the enabled/protocol gating is preserved.
 */
export async function loadSamlConfig(
  store: IdpConfigStore,
  tenantId: string,
): Promise<IdpConfig | null> {
  const config = await store.get(tenantId);
  if (!config || config.protocol !== "saml" || !config.enabled) return null;
  return config;
}

/** Translate one `IdpConfig` into a `SamlConfig`. */
function toSamlConfig(config: IdpConfig): SamlConfig {
  if (config.protocol !== "saml") {
    throw new SamlValidationError("unknown", `Configuration ${config.id} is not a SAML provider`);
  }
  if (!config.idp_x509_cert) {
    throw new SamlValidationError("unknown", "SAML provider is missing idp_x509_cert");
  }
  if (!config.idp_sso_url) {
    throw new SamlValidationError("unknown", "SAML provider is missing idp_sso_url");
  }
  const spEntityId = config.sp_entity_id || "";
  const spAcsUrl = config.sp_acs_url || "";
  if (!spEntityId || !spAcsUrl) {
    throw new SamlValidationError(
      "unknown",
      "SAML provider is missing sp_entity_id or sp_acs_url — populate defaults before calling the SP wrapper",
    );
  }
  return {
    idpCert: config.idp_x509_cert,
    issuer: spEntityId,
    callbackUrl: spAcsUrl,
    entryPoint: config.idp_sso_url,
    idpIssuer: config.idp_entity_id || undefined,
    audience: spEntityId,
    wantAssertionsSigned: config.want_assertions_signed !== false,
    // We never validate InResponseTo because we don't persist the outbound
    // request IDs across processes. This is the same posture Okta's own
    // sample app takes and matches what we document in the README.
    validateInResponseTo: "never" as SamlConfig["validateInResponseTo"],
    // 30 second clock skew tolerance (library default is 0).
    acceptedClockSkewMs: 30_000,
  } as SamlConfig;
}

/** Get (or create and cache) a `SAML` instance for a configuration. */
export function getSamlInstance(config: IdpConfig): SAML {
  const key = `${config.id}:${config.updated_at}`;
  const cached = instanceCache.get(config.id);
  if (cached && cached.key === key) {
    return cached.saml;
  }
  const saml = new SAML(toSamlConfig(config));
  instanceCache.set(config.id, { key, saml });
  return saml;
}

/**
 * Build the URL to redirect the browser to in order to start an SP-initiated
 * SAML login. The host parameter should be the `Host:` header value of the
 * incoming request — `@node-saml/node-saml` uses it to construct the issuer
 * in the AuthnRequest when the issuer option is a relative path (we supply
 * a fully qualified issuer, so host is effectively unused but required by the API).
 */
export async function buildLoginRedirectUrl(
  config: IdpConfig,
  relayState: string,
  host: string,
): Promise<string> {
  const saml = getSamlInstance(config);
  try {
    return await saml.getAuthorizeUrlAsync(relayState, host, {});
  } catch (e: unknown) {
    throw new SamlValidationError(
      "unknown",
      `Failed to build SAML authorize URL: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}

/**
 * Validate a SAMLResponse received via the HTTP-POST binding and return a
 * normalised assertion. The caller is responsible for extracting the
 * `SAMLResponse` form field from the request body.
 */
export async function validateSamlResponse(
  config: IdpConfig,
  samlResponseBase64: string,
): Promise<SamlAssertion> {
  if (!samlResponseBase64) {
    throw new SamlValidationError("missing_saml_response", "SAMLResponse form field is empty");
  }
  const saml = getSamlInstance(config);
  let profile: Profile | null;
  let loggedOut: boolean;
  try {
    const result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponseBase64 });
    profile = result.profile;
    loggedOut = result.loggedOut;
  } catch (e: unknown) {
    throw mapLibraryError(e);
  }
  if (loggedOut) {
    throw new SamlValidationError("logged_out", "SAMLResponse was a logout, not a login assertion");
  }
  if (!profile) {
    throw new SamlValidationError("missing_name_id", "SAMLResponse did not contain a profile");
  }
  return profileToAssertion(config, profile);
}

/**
 * Translate a Passport-style profile into our `SamlAssertion` shape.
 *
 * Email resolution order:
 *   1. The attribute named by `config.attribute_mapping.email` (if present)
 *   2. `profile.email` / `profile.mail`
 *   3. NameID when `nameIDFormat` is `...emailAddress`
 */
function profileToAssertion(config: IdpConfig, profile: Profile): SamlAssertion {
  const emailAttr = config.attribute_mapping?.email || "email";
  const attributes = extractAttributes(profile);
  const email =
    pickString(attributes[emailAttr]) ||
    pickString(profile.email) ||
    pickString(profile.mail) ||
    (isEmailNameId(profile) ? profile.nameID : "");

  if (!email) {
    throw new SamlValidationError(
      "missing_email",
      `SAMLResponse did not provide an email (attribute=${emailAttr})`,
    );
  }

  return {
    nameId: profile.nameID || email,
    issuer: profile.issuer,
    audience: config.sp_entity_id || "",
    sessionIndex: profile.sessionIndex,
    attributes: { ...attributes, email },
    // node-saml does not expose notBefore/notOnOrAfter on Profile, so we
    // stamp the moment we successfully validated instead. Consumers that
    // need the IdP-issued values can call `profile.getAssertion?.()`.
    issuedAt: new Date().toISOString(),
    notOnOrAfter: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
}

/** Pull stringifiable attributes out of a Passport-style profile bag. */
function extractAttributes(profile: Profile): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const reserved = new Set([
    "issuer",
    "sessionIndex",
    "nameID",
    "nameIDFormat",
    "nameQualifier",
    "spNameQualifier",
    "ID",
    "getAssertionXml",
    "getAssertion",
    "getSamlResponseXml",
  ]);
  for (const [key, value] of Object.entries(profile)) {
    if (reserved.has(key)) continue;
    if (typeof value === "function") continue;
    if (typeof value === "string") {
      result[key] = value;
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      result[key] = value as string[];
    }
  }
  return result;
}

function pickString(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

function isEmailNameId(profile: Profile): boolean {
  return (
    typeof profile.nameID === "string" &&
    profile.nameID.includes("@") &&
    (profile.nameIDFormat?.includes("emailAddress") ?? false)
  );
}

/**
 * Map an error from `@node-saml/node-saml` onto one of our stable codes.
 * The library does not export typed error classes so we inspect messages,
 * which is fragile but the best we can do without patching upstream.
 */
function mapLibraryError(e: unknown): SamlValidationError {
  const message = e instanceof Error ? e.message : String(e);
  const lower = message.toLowerCase();
  if (lower.includes("invalid signature") || lower.includes("signature not valid")) {
    return new SamlValidationError("invalid_signature", message, { cause: e });
  }
  if (lower.includes("notbefore") || lower.includes("notonorafter") || lower.includes("expired")) {
    return new SamlValidationError("expired_assertion", message, { cause: e });
  }
  if (lower.includes("audience")) {
    return new SamlValidationError("audience_mismatch", message, { cause: e });
  }
  if (lower.includes("issuer")) {
    return new SamlValidationError("issuer_mismatch", message, { cause: e });
  }
  return new SamlValidationError("unknown", message, { cause: e });
}
