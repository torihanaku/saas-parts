/**
 * Unit tests for saml-sp.ts — ported from dev-dashboard-v2
 * `tests/saml-sp.test.ts` (#110 / Epic G8 Backend PR).
 *
 * Scope:
 *   - IdpConfig → @node-saml/node-saml options translation
 *   - Profile → SamlAssertion normalisation
 *   - Instance cache keyed by `config.id + updated_at`
 *   - Error mapping from library exceptions to SamlErrorCode
 *   - Injected IdpConfigStore lookup (replaces Supabase persistence)
 *
 * `@node-saml/node-saml` is mocked so these tests stay synchronous and
 * don't require real crypto fixtures.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { samlCtorSpy, getAuthorizeUrlSpy, validatePostResponseSpy } = vi.hoisted(() => ({
  samlCtorSpy: vi.fn(),
  getAuthorizeUrlSpy: vi.fn(),
  validatePostResponseSpy: vi.fn(),
}));

vi.mock("@node-saml/node-saml", () => {
  class MockSAML {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      samlCtorSpy(options);
      this.options = options;
    }
    getAuthorizeUrlAsync(relayState: string, host: string | undefined) {
      return getAuthorizeUrlSpy(relayState, host);
    }
    validatePostResponseAsync(container: Record<string, string>) {
      return validatePostResponseSpy(container);
    }
  }
  return { SAML: MockSAML };
});

import {
  buildLoginRedirectUrl,
  validateSamlResponse,
  getSamlInstance,
  clearSamlInstanceCache,
  loadSamlConfig,
  SamlValidationError,
} from "./saml-sp";
import type { IdpConfig, IdpConfigStore } from "./types";

const baseConfig: IdpConfig = {
  id: "okta-prod",
  provider_name: "Okta Production",
  protocol: "saml",
  metadata_url: "",
  client_id: "",
  client_secret: "",
  issuer: "",
  callback_url: "",
  enabled: true,
  created_at: "2026-04-15T00:00:00Z",
  updated_at: "2026-04-15T00:00:00Z",
  attribute_mapping: { email: "email", name: "name" },
  idp_entity_id: "https://idp.example.com/saml",
  idp_sso_url: "https://idp.example.com/saml/sso",
  idp_x509_cert: "-----BEGIN CERTIFICATE-----\nMIIC...FAKE...\n-----END CERTIFICATE-----",
  sp_entity_id: "https://dash.example.com/sso/saml/okta-prod",
  sp_acs_url: "https://dash.example.com/auth/saml/acs/okta-prod",
  sign_requests: false,
  want_assertions_signed: true,
};

beforeEach(() => {
  clearSamlInstanceCache();
  samlCtorSpy.mockReset();
  getAuthorizeUrlSpy.mockReset();
  validatePostResponseSpy.mockReset();
});

describe("getSamlInstance — config translation", () => {
  it("maps IdpConfig fields onto @node-saml SamlConfig", () => {
    getSamlInstance(baseConfig);
    expect(samlCtorSpy).toHaveBeenCalledTimes(1);
    const options = samlCtorSpy.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      idpCert: baseConfig.idp_x509_cert,
      issuer: baseConfig.sp_entity_id,
      callbackUrl: baseConfig.sp_acs_url,
      entryPoint: baseConfig.idp_sso_url,
      idpIssuer: baseConfig.idp_entity_id,
      audience: baseConfig.sp_entity_id,
      wantAssertionsSigned: true,
      validateInResponseTo: "never",
      acceptedClockSkewMs: 30_000,
    });
  });

  it("propagates want_assertions_signed=false", () => {
    getSamlInstance({ ...baseConfig, want_assertions_signed: false });
    expect(samlCtorSpy.mock.calls[0]?.[0]).toMatchObject({ wantAssertionsSigned: false });
  });

  it("caches the SAML instance by id+updated_at", () => {
    const a1 = getSamlInstance(baseConfig);
    const a2 = getSamlInstance(baseConfig);
    expect(a1).toBe(a2);
    expect(samlCtorSpy).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the SAML instance when updated_at changes", () => {
    getSamlInstance(baseConfig);
    getSamlInstance({ ...baseConfig, updated_at: "2026-04-15T05:00:00Z" });
    expect(samlCtorSpy).toHaveBeenCalledTimes(2);
  });

  it("clearSamlInstanceCache() forces reconstruction", () => {
    getSamlInstance(baseConfig);
    clearSamlInstanceCache();
    getSamlInstance(baseConfig);
    expect(samlCtorSpy).toHaveBeenCalledTimes(2);
  });

  it("throws SamlValidationError if protocol is not saml", () => {
    expect(() => getSamlInstance({ ...baseConfig, protocol: "oidc" })).toThrow(SamlValidationError);
  });

  it("throws SamlValidationError when idp_x509_cert is missing", () => {
    expect(() => getSamlInstance({ ...baseConfig, idp_x509_cert: "" })).toThrow(/idp_x509_cert/);
  });

  it("throws SamlValidationError when idp_sso_url is missing", () => {
    expect(() => getSamlInstance({ ...baseConfig, idp_sso_url: "" })).toThrow(/idp_sso_url/);
  });

  it("throws SamlValidationError when sp_entity_id or sp_acs_url are missing", () => {
    expect(() => getSamlInstance({ ...baseConfig, sp_entity_id: "" })).toThrow(/sp_entity_id/);
    expect(() => getSamlInstance({ ...baseConfig, sp_acs_url: "" })).toThrow(/sp_acs_url/);
  });
});

describe("buildLoginRedirectUrl", () => {
  it("delegates to SAML.getAuthorizeUrlAsync and returns the resulting URL", async () => {
    getAuthorizeUrlSpy.mockResolvedValueOnce("https://idp.example.com/sso?SAMLRequest=ABC");
    const url = await buildLoginRedirectUrl(baseConfig, "/dashboard", "dash.example.com");
    expect(url).toBe("https://idp.example.com/sso?SAMLRequest=ABC");
    expect(getAuthorizeUrlSpy).toHaveBeenCalledWith("/dashboard", "dash.example.com");
  });

  it("wraps library errors in SamlValidationError", async () => {
    getAuthorizeUrlSpy.mockRejectedValueOnce(new Error("library exploded"));
    await expect(buildLoginRedirectUrl(baseConfig, "/", "dash.example.com")).rejects.toMatchObject({
      name: "SamlValidationError",
      code: "unknown",
    });
  });
});

describe("validateSamlResponse — success paths", () => {
  it("returns a normalised SamlAssertion when validation succeeds", async () => {
    validatePostResponseSpy.mockResolvedValueOnce({
      profile: {
        issuer: "https://idp.example.com/saml",
        nameID: "alice@example.com",
        nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        email: "alice@example.com",
        name: "Alice Test",
        department: "Engineering",
      },
      loggedOut: false,
    });

    const assertion = await validateSamlResponse(baseConfig, "base64response");
    expect(assertion.nameId).toBe("alice@example.com");
    expect(assertion.issuer).toBe("https://idp.example.com/saml");
    expect(assertion.audience).toBe(baseConfig.sp_entity_id);
    expect(assertion.attributes.email).toBe("alice@example.com");
    expect(assertion.attributes.name).toBe("Alice Test");
    expect(assertion.attributes.department).toBe("Engineering");
  });

  it("resolves email via a custom attribute mapping key", async () => {
    validatePostResponseSpy.mockResolvedValueOnce({
      profile: {
        issuer: "https://idp.example.com/saml",
        nameID: "alice",
        nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": "alice@example.com",
      },
      loggedOut: false,
    });
    const config: IdpConfig = {
      ...baseConfig,
      attribute_mapping: {
        email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
        name: "name",
      },
    };
    const assertion = await validateSamlResponse(config, "base64response");
    expect(assertion.attributes.email).toBe("alice@example.com");
  });

  it("falls back to NameID when nameIDFormat is emailAddress and no attribute email is present", async () => {
    validatePostResponseSpy.mockResolvedValueOnce({
      profile: {
        issuer: "https://idp.example.com/saml",
        nameID: "alice@example.com",
        nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      },
      loggedOut: false,
    });
    const assertion = await validateSamlResponse(baseConfig, "base64response");
    expect(assertion.attributes.email).toBe("alice@example.com");
  });
});

describe("validateSamlResponse — error paths", () => {
  it("throws missing_saml_response for empty input", async () => {
    await expect(validateSamlResponse(baseConfig, "")).rejects.toMatchObject({
      code: "missing_saml_response",
    });
  });

  it("throws logged_out when the library reports a logout response", async () => {
    validatePostResponseSpy.mockResolvedValueOnce({ profile: null, loggedOut: true });
    await expect(validateSamlResponse(baseConfig, "base64response")).rejects.toMatchObject({
      code: "logged_out",
    });
  });

  it("throws missing_name_id when the library returns a null profile for a login", async () => {
    validatePostResponseSpy.mockResolvedValueOnce({ profile: null, loggedOut: false });
    await expect(validateSamlResponse(baseConfig, "base64response")).rejects.toMatchObject({
      code: "missing_name_id",
    });
  });

  it("throws missing_email when neither attribute nor nameID yields an email", async () => {
    validatePostResponseSpy.mockResolvedValueOnce({
      profile: {
        issuer: "https://idp.example.com/saml",
        nameID: "alice-persistent-id",
        nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      },
      loggedOut: false,
    });
    await expect(validateSamlResponse(baseConfig, "base64response")).rejects.toMatchObject({
      code: "missing_email",
    });
  });

  it("maps library 'invalid signature' errors to invalid_signature", async () => {
    validatePostResponseSpy.mockRejectedValueOnce(new Error("Invalid signature"));
    await expect(validateSamlResponse(baseConfig, "base64response")).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });

  it("maps library 'NotOnOrAfter' errors to expired_assertion", async () => {
    validatePostResponseSpy.mockRejectedValueOnce(new Error("Assertion NotOnOrAfter is in the past"));
    await expect(validateSamlResponse(baseConfig, "base64response")).rejects.toMatchObject({
      code: "expired_assertion",
    });
  });

  it("maps library 'audience' errors to audience_mismatch", async () => {
    validatePostResponseSpy.mockRejectedValueOnce(new Error("Audience URI is not valid"));
    await expect(validateSamlResponse(baseConfig, "base64response")).rejects.toMatchObject({
      code: "audience_mismatch",
    });
  });

  it("maps library 'issuer' errors to issuer_mismatch", async () => {
    validatePostResponseSpy.mockRejectedValueOnce(new Error("Unknown SAML issuer"));
    await expect(validateSamlResponse(baseConfig, "base64response")).rejects.toMatchObject({
      code: "issuer_mismatch",
    });
  });

  it("falls back to 'unknown' code for unrecognised errors", async () => {
    validatePostResponseSpy.mockRejectedValueOnce(new Error("something weird happened"));
    await expect(validateSamlResponse(baseConfig, "base64response")).rejects.toMatchObject({
      code: "unknown",
    });
  });
});

describe("loadSamlConfig — injected IdpConfigStore", () => {
  const storeWith = (config: IdpConfig | null): IdpConfigStore => ({
    get: vi.fn().mockResolvedValue(config),
  });

  it("returns the config when the store yields an enabled SAML provider", async () => {
    const store = storeWith(baseConfig);
    const config = await loadSamlConfig(store, "tenant-1");
    expect(config).toEqual(baseConfig);
    expect(store.get).toHaveBeenCalledWith("tenant-1");
  });

  it("returns null when the store has no config for the tenant", async () => {
    expect(await loadSamlConfig(storeWith(null), "tenant-1")).toBeNull();
  });

  it("returns null when the provider is disabled", async () => {
    expect(await loadSamlConfig(storeWith({ ...baseConfig, enabled: false }), "tenant-1")).toBeNull();
  });

  it("returns null when the provider is not SAML", async () => {
    expect(await loadSamlConfig(storeWith({ ...baseConfig, protocol: "oidc" }), "tenant-1")).toBeNull();
  });
});
