/**
 * @torihanaku/saml-sp — SAML 2.0 Service Provider wrapper.
 * Public API surface. See README.md for usage.
 */

export type { IdpConfig, IdpConfigStore, SamlAssertion } from "./types";
export {
  buildLoginRedirectUrl,
  validateSamlResponse,
  getSamlInstance,
  clearSamlInstanceCache,
  loadSamlConfig,
  SamlValidationError,
  type SamlErrorCode,
} from "./saml-sp";
export { buildSpMetadataXml } from "./metadata";
