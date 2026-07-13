/**
 * @torihanaku/feature-flags — public API.
 *
 * Env-var toggle + per-tenant override + audit trail feature flags,
 * fully decoupled via injected interfaces.
 * Origin: 実運用SaaS server/lib/feature-flags.ts
 *         (+ mutation behavior of server/routes/feature-flag-overrides.ts).
 */

export {
  FeatureFlagClient,
  defineFlags,
  processEnvSource,
} from "./feature-flag-client";
export { InMemoryOverrideStore } from "./memory-store";
export type {
  EnvSource,
  FeatureFlagClientOptions,
  FlagAuditEvent,
  FlagAuditSink,
  FlagDefinition,
  FlagDetail,
  FlagOverrideStore,
  FlagRegistry,
  OverrideRecord,
  TenantElevator,
} from "./types";
