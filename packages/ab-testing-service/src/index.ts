/**
 * @torihanaku/ab-testing-service
 *
 * AI-native A/B testing experiment lifecycle (create → AI variant generation →
 * measure → winner decision → end). Persistence, bandit allocation, and
 * significance testing are injected.
 *
 * `@torihanaku/thompson-bandit` satisfies the `Allocator` interface and
 * `@torihanaku/ab-significance` satisfies the `SignificanceTester` interface,
 * but neither is imported here — see README.
 */

export * from "./types.js";
export * from "./store.js";
export * from "./ab-testing-service.js";
export * from "./claude-variant-generator.js";
export * from "./client/useAbTesting.js";
