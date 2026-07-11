/**
 * @torihanaku/bias-detector
 *
 * AI cognitive-bias detection for marketing decisions. The bias taxonomy is an
 * extensible registry (6 source biases as defaults), the LLM is injected, and
 * the auto-trigger's feature-flag / store / notifier are injected.
 */

export * from "./types.js";
export * from "./registry.js";
export * from "./decision-trigger.js";
export * from "./client/useBiasDetections.js";

// Re-export claude-detector (v1) without its internal `__testing`.
export {
  detectBiasesClaudeV1,
  CLAUDE_DETECTOR_VERSION,
  CLAUDE_DETECTOR_THRESHOLD,
  type ClaudeBiasDetection,
} from "./claude-detector.js";

// Re-export the service factories. `__testing` (legacy) is intentionally
// not exported to avoid a name collision with the v1 detector's internal.
export {
  createBiasDetectorService,
  createLegacySingleShotDetector,
  BIAS_CONFIDENCE_THRESHOLD,
  type BiasDetectorService,
} from "./bias-detector.js";
