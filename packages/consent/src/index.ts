export {
  createConsentGuard,
  EXAMPLE_COS_REVOCATION_CASCADE,
  type ConsentGuard,
  type ConsentGuardOptions,
  type ConsentRevocationResult,
  type CascadePurgeTarget,
  type RevocationCascadeMap,
} from "./guard";
export {
  InMemoryConsentStore,
  type ConsentStore,
  type ConsentStoreResult,
} from "./store";
export {
  ConsentMissingError,
  EXAMPLE_CONSENT_PURPOSES,
  CONSENT_BASIS,
  type ExampleConsentPurpose,
  type ConsentBasis,
  type ConsentRecord,
} from "./types";
