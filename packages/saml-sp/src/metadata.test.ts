/**
 * Unit tests for metadata.ts — `buildSpMetadataXml` cases ported from
 * 実運用SaaS `tests/saml-routes.test.ts` (module logic only; the
 * HTTP route cases from that file were intentionally not ported).
 */
import { describe, it, expect } from "vitest";
import { buildSpMetadataXml } from "./metadata";
import type { IdpConfig } from "./types";

const baseSamlConfig: IdpConfig = {
  id: "okta-prod",
  provider_name: "Okta Production",
  protocol: "saml",
  enabled: true,
  created_at: "2026-04-15T00:00:00Z",
  updated_at: "2026-04-15T00:00:00Z",
  attribute_mapping: { email: "email" },
  idp_entity_id: "https://idp.example.com/saml",
  idp_sso_url: "https://idp.example.com/saml/sso",
  idp_x509_cert: "MIIC...FAKE...",
  sp_entity_id: "https://dash.example.com/sso/saml/okta-prod",
  sp_acs_url: "https://dash.example.com/auth/saml/acs/okta-prod",
  want_assertions_signed: true,
};

describe("buildSpMetadataXml", () => {
  it("produces a valid EntityDescriptor with the expected entityID and ACS", () => {
    const xml = buildSpMetadataXml(
      baseSamlConfig,
      "https://dash.example.com/sso/saml/okta-prod",
      "https://dash.example.com/auth/saml/acs/okta-prod",
    );
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"');
    expect(xml).toContain('entityID="https://dash.example.com/sso/saml/okta-prod"');
    expect(xml).toContain('Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"');
    expect(xml).toContain('Location="https://dash.example.com/auth/saml/acs/okta-prod"');
    expect(xml).toContain('WantAssertionsSigned="true"');
  });

  it("honors want_assertions_signed=false when set", () => {
    const xml = buildSpMetadataXml(
      { ...baseSamlConfig, want_assertions_signed: false },
      "https://dash.example.com/sso/saml/okta-prod",
      "https://dash.example.com/auth/saml/acs/okta-prod",
    );
    expect(xml).toContain('WantAssertionsSigned="false"');
  });

  it("escapes XML-unsafe characters in entity IDs and ACS URLs", () => {
    const xml = buildSpMetadataXml(
      { ...baseSamlConfig, sp_entity_id: "", sp_acs_url: "" },
      'https://dash.example.com/sso/"evil"&<tag>',
      "https://dash.example.com/acs?q=1&r=2",
    );
    expect(xml).toContain("&quot;evil&quot;");
    expect(xml).toContain("&amp;&lt;tag&gt;");
    expect(xml).toContain("q=1&amp;r=2");
  });
});
