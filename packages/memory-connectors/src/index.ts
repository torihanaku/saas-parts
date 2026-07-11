/**
 * @torihanaku/memory-connectors
 *
 * Concrete Notion / Slack decision extractors + Slack handoff delivery +
 * embedding cost pipeline, dropped from `@torihanaku/kit-decision-memory` (which
 * kept only the `SourceExtractor` contract). Output shapes match that kit's
 * contract so they pair without an import — see README.
 *
 * All external I/O (Notion / Slack HTTP, LLM, embeddings, cost ledger) is
 * injected; no direct SDK or secret dependency.
 */

export * from "./types.js";
export * from "./notion-extractor.js";
export * from "./slack-extractor.js";
export * from "./handoff-slack.js";
export * from "./embedding-pipeline.js";
