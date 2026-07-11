/**
 * Slack message decision extraction (ported from dev-dashboard-v2
 * institutional-memory/slack-extractor).
 *
 * Extracts a single decision from a Slack message and persists it as a
 * pending (human-review) row. Consent check, LLM, and persistence are all
 * injected. Output matches kit-decision-memory's decision vocabulary, and a
 * `SourceCandidate` builder is exported for the SourceExtractor pairing.
 */

import type {
  DecisionType,
  MemoryLlmClient,
  MemoryLogger,
  SourceCandidate,
} from "./types.js";
import { NOOP_LOGGER } from "./types.js";

export const SLACK_EXTRACTION_PROMPT = `
以下の Slack メッセージから「意思決定」を抽出してください。
意思決定とは "〇〇をやめる/始める/変える" 等の方針決定です。
JSON で以下を出力: { "found": boolean, "type": "start|stop|change|pivot|archive"|null, "subject": string|null, "reason": string|null, "confidence": 0.0-1.0 }
雑談や質問だけの場合は found: false。
`;

export interface SlackExtraction {
  found?: boolean;
  type?: DecisionType | string | null;
  subject?: string | null;
  reason?: string | null;
  confidence?: number;
}

export interface SlackExtractInput {
  tenantId: string;
  slackPermalink: string;
  slackChannel: string;
  rawText: string;
}

/** A row prepared for persistence of a Slack-extracted decision. */
export interface SlackExtractedRow {
  tenantId: string;
  slackPermalink: string;
  slackChannel: string;
  rawText: string;
  extractedType: DecisionType | string | null;
  extractedSubject: string | null;
  extractedReason: string | null;
  confidence: number;
  status: "pending";
}

/** Injected persistence. Returns the new row id, or null on failure. */
export interface SlackExtractStore {
  insertExtractedDecision(row: SlackExtractedRow): Promise<string | null>;
}

/** Injected consent gate for external-content analysis. */
export type ConsentCheck = (
  tenantId: string,
  scope: string,
) => Promise<boolean>;

export interface SlackExtractDeps {
  llm: MemoryLlmClient;
  store: SlackExtractStore;
  /** Consent gate. Defaults to always-granted when omitted. */
  hasConsent?: ConsentCheck;
  logger?: MemoryLogger;
}

/** Build a `SourceCandidate` (kit-decision-memory pairing) from a Slack message. */
export function slackCandidate(input: {
  slackPermalink: string;
  rawText: string;
  decidedAt?: string;
}): SourceCandidate {
  return {
    sourceRef: input.slackPermalink,
    rawText: input.rawText,
    ...(input.decidedAt ? { decidedAt: input.decidedAt } : {}),
  };
}

export async function extractDecisionFromSlack(
  params: SlackExtractInput,
  deps: SlackExtractDeps,
): Promise<{ extractedId: string | null; skipped: boolean }> {
  const logger = deps.logger ?? NOOP_LOGGER;
  const hasConsent = deps.hasConsent ?? (async () => true);

  const ok = await hasConsent(params.tenantId, "slack_content_analysis");
  if (!ok) {
    logger.warn(
      "institutional-memory",
      JSON.stringify({
        severity: "INFO",
        message: "slack_extraction_skipped_no_consent",
        tenant_id: params.tenantId,
      }),
    );
    return { extractedId: null, skipped: true };
  }

  const parsed = await deps.llm.generateJson<SlackExtraction | null>(
    "",
    `${SLACK_EXTRACTION_PROMPT}\n\nメッセージ:\n${params.rawText}`,
    null,
    { maxTokens: 300 },
  );

  if (!parsed || !parsed.found) return { extractedId: null, skipped: true };

  const id = await deps.store.insertExtractedDecision({
    tenantId: params.tenantId,
    slackPermalink: params.slackPermalink,
    slackChannel: params.slackChannel,
    rawText: params.rawText,
    extractedType: parsed.type ?? null,
    extractedSubject: parsed.subject ?? null,
    extractedReason: parsed.reason ?? null,
    confidence: parsed.confidence ?? 0.5,
    status: "pending",
  });

  if (!id) return { extractedId: null, skipped: true };
  return { extractedId: id, skipped: false };
}
