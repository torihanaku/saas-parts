/**
 * Consent domain types.
 * Ported from dev-dashboard-v2 `shared/types/consent.ts`.
 * The purpose enum is now a generic string union supplied by the caller;
 * the source purposes are kept below as a documented example.
 */

/**
 * Purposes used by the source application — documented example set.
 * Define your own union and pass it as `createConsentGuard<TPurpose>`.
 */
export const EXAMPLE_CONSENT_PURPOSES = [
  "slack_ingestion",
  "ai_learning",
  "email_digest",
  "behavior_analytics",
  // Chief-of-Staff external data processing (個情法 18 条)
  "external_data_processing", // umbrella for cos_* sources
  "slack_content_analysis",
  "email_content_analysis",
  "meeting_transcript_analysis",
] as const;
export type ExampleConsentPurpose = (typeof EXAMPLE_CONSENT_PURPOSES)[number];

/** Legal basis classification (GDPR Art. 6 subset used by the source). */
export const CONSENT_BASIS = [
  "explicit_consent",
  "contract",
  "legal_obligation",
  "legitimate_interest",
] as const;
export type ConsentBasis = (typeof CONSENT_BASIS)[number];

export interface ConsentRecord<TPurpose extends string = string> {
  tenantId: string;
  userId: string;
  purpose: TPurpose;
  basis: ConsentBasis;
  grantedAt: string;
  revokedAt?: string | null;
}

/**
 * Thrown by `requireConsent` when consent is missing.
 * Source version extended AppError(403, ..., 'CONSENT_MISSING');
 * status/code are kept as plain properties to stay dependency-free.
 */
export class ConsentMissingError extends Error {
  readonly status = 403;
  readonly code = "CONSENT_MISSING";
  constructor(purpose: string) {
    super(`Consent required for purpose: ${purpose}`);
    this.name = "ConsentMissingError";
  }
}
