export {
  DEFAULT_CSP,
  RELAXED_CSP,
  DEFAULT_CALLBACK_PATH_PREFIXES,
  DEFAULT_RELAXED_CSP_PATH_PREFIXES,
  resolveConfig,
  isCrossOriginProtocolPath,
  securityHeadersFor,
  corsHeadersFor,
  corsPreflightHeadersFor,
  checkCsrfOrigin,
  evaluateCors,
  type HeadersRecord,
  type SecurityConfig,
  type ResolvedSecurityConfig,
  type SecurityHeadersInput,
  type CsrfOriginInput,
  type CsrfOriginDecision,
  type CorsEvaluation,
} from "./security";

export { addSecurityHeaders, addCorsHeaders, handleCors } from "./adapter";
