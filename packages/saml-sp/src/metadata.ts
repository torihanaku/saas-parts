/**
 * SP metadata XML generation.
 *
 * Ported from 実運用SaaS `server/routes/auth/saml-helpers.ts`
 * (`buildSpMetadataXml`). Pure function — the caller serves the returned
 * string from its own metadata endpoint (suggested Content-Type:
 * `application/samlmetadata+xml; charset=utf-8`).
 */

import type { IdpConfig } from "./types";

/**
 * Build SP metadata XML for the given provider configuration.
 * IdPs consume this to learn our entity ID and ACS URL.
 *
 * `spEntityId` / `acsUrl` are fallbacks used when the config does not set
 * `sp_entity_id` / `sp_acs_url` explicitly (e.g. defaults derived from the
 * request origin by the caller).
 */
export function buildSpMetadataXml(config: IdpConfig, spEntityId: string, acsUrl: string): string {
  const entityId = config.sp_entity_id || spEntityId;
  const assertionConsumerService = config.sp_acs_url || acsUrl;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"',
    `  entityID="${escapeXml(entityId)}">`,
    '  <md:SPSSODescriptor',
    '    AuthnRequestsSigned="false"',
    `    WantAssertionsSigned="${config.want_assertions_signed === false ? "false" : "true"}"`,
    '    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
    '    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>',
    '    <md:AssertionConsumerService',
    '      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"',
    `      Location="${escapeXml(assertionConsumerService)}"`,
    '      index="0"',
    '      isDefault="true"/>',
    '  </md:SPSSODescriptor>',
    '</md:EntityDescriptor>',
  ].join("\n");
}

function escapeXml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
