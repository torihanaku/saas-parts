/**
 * Notion page decision-candidate ingest (ported from dev-dashboard-v2
 * institutional-memory/notion-extractor, MEM-1b / #1376).
 *
 * Notion is a staging source: likely decisions are extracted from pages and
 * stored as reviewable candidates rather than immutable decision-log rows.
 *
 * The LLM is injected (`MemoryLlmClient`), and candidate persistence is injected
 * (`NotionCandidateStore`). Parsing / normalization are pure.
 */

import type { DecisionType, MemoryLlmClient, MemoryLogger } from "./types.js";
import { NOOP_LOGGER } from "./types.js";

export type NotionDecisionType = DecisionType;

export interface NotionPageInput {
  id: string;
  title: string;
  content: string;
  url?: string | null;
  lastEditedTime?: string | null;
  raw?: unknown;
}

export interface NotionDecisionCandidate {
  pageId: string;
  title: string | null;
  type: NotionDecisionType;
  subject: string;
  reason: string;
  context: string | null;
  confidence: number;
}

export interface NotionDecisionIngestResult {
  inserted: number;
  candidates: NotionDecisionCandidate[];
  reason: "inserted" | "no_candidates" | "invalid_payload" | "db_error";
}

/** A candidate row prepared for persistence. */
export interface NotionCandidateRow {
  tenantId: string;
  source: "notion";
  sourceRef: string;
  sourceUrl: string | null;
  title: string | null;
  decisionType: NotionDecisionType;
  subject: string;
  reason: string;
  context: string | null;
  confidence: number;
  status: "pending";
  rawPayload: {
    page: unknown;
    extractedBy: string;
    lastEditedTime: string | null;
  };
}

/**
 * Injected persistence for Notion candidates. Upserts on
 * (tenant, source, sourceRef, subject). Returns the number of rows written,
 * or null on failure.
 */
export interface NotionCandidateStore {
  upsertCandidates(rows: NotionCandidateRow[]): Promise<number | null>;
}

const VALID_TYPES = new Set<NotionDecisionType>([
  "start",
  "stop",
  "change",
  "pivot",
  "archive",
]);
const MAX_PAGES = 25;
const MAX_PAGE_CHARS = 1500;
const MIN_CONFIDENCE = 0.6;

const SYSTEM_PROMPT = `あなたはマーケティング組織の Notion ナレッジから意思決定候補を抽出するレビュアーです。
入力された複数の Notion ページから、明確に「始める/やめる/変える/軸を変える/アーカイブする」と読める意思決定だけを候補化してください。
未決定のメモ、TODO、単なる観察、議論中の選択肢は除外してください。出力は JSON のみです。`;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clampConfidence(value: unknown): number {
  return typeof value === "number" ? Math.max(0, Math.min(1, value)) : 0;
}

function textFromRichText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as Record<string, unknown>;
      return (
        asString(item.plain_text) ??
        asString((item.text as Record<string, unknown> | undefined)?.content) ??
        ""
      );
    })
    .filter(Boolean)
    .join("");
}

function titleFromProperties(properties: unknown): string | null {
  if (!properties || typeof properties !== "object") return null;
  for (const value of Object.values(properties as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const prop = value as Record<string, unknown>;
    if (prop.type === "title") {
      const title = textFromRichText(prop.title);
      if (title) return title;
    }
  }
  return null;
}

function contentFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, unknown>;
      const type = asString(b.type);
      if (!type) return "";
      const typed = b[type];
      if (!typed || typeof typed !== "object") return "";
      return textFromRichText((typed as Record<string, unknown>).rich_text);
    })
    .filter(Boolean)
    .join("\n");
}

export function parseNotionPages(payload: unknown): NotionPageInput[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const rawPages = Array.isArray(root.pages)
    ? root.pages
    : Array.isArray(root.results)
      ? root.results
      : Array.isArray(root.data)
        ? root.data
        : [root.page ?? root];

  return rawPages
    .map((raw, index): NotionPageInput | null => {
      if (!raw || typeof raw !== "object") return null;
      const page = raw as Record<string, unknown>;
      const id =
        asString(page.id) ?? asString(page.page_id) ?? `notion-page-${index}`;
      const title =
        asString(page.title) ??
        asString(page.name) ??
        titleFromProperties(page.properties) ??
        "Untitled";
      const content =
        asString(page.content) ??
        asString(page.text) ??
        asString(page.markdown) ??
        contentFromBlocks(page.blocks);
      if (!content) return null;
      return {
        id,
        title,
        content,
        url: asString(page.url),
        lastEditedTime:
          asString(page.last_edited_time) ?? asString(page.lastEditedTime),
        raw,
      };
    })
    .filter((page): page is NotionPageInput => page !== null)
    .slice(0, MAX_PAGES);
}

function normalizeCandidates(
  raw: unknown,
  pages: NotionPageInput[],
): NotionDecisionCandidate[] {
  const values =
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as Record<string, unknown>).candidates)
      ? ((raw as Record<string, unknown>).candidates as unknown[])
      : Array.isArray(raw)
        ? raw
        : [];
  const pageIds = new Set(pages.map((page) => page.id));

  return values.flatMap((item): NotionDecisionCandidate[] => {
    if (!item || typeof item !== "object") return [];
    const rawCandidate = item as Record<string, unknown>;
    const pageId =
      asString(rawCandidate.pageId) ?? asString(rawCandidate.page_id);
    const type = asString(rawCandidate.type);
    const subject = asString(rawCandidate.subject);
    const reason = asString(rawCandidate.reason);
    const confidence = clampConfidence(rawCandidate.confidence);
    if (
      !pageId ||
      !pageIds.has(pageId) ||
      !type ||
      !VALID_TYPES.has(type as NotionDecisionType)
    ) {
      return [];
    }
    if (!subject || !reason || confidence < MIN_CONFIDENCE) return [];
    return [
      {
        pageId,
        title: asString(rawCandidate.title),
        type: type as NotionDecisionType,
        subject,
        reason,
        context: asString(rawCandidate.context),
        confidence,
      },
    ];
  });
}

function buildPrompt(pages: NotionPageInput[]): string {
  const body = pages
    .map((page, index) =>
      [
        `#${index + 1}`,
        `pageId: ${page.id}`,
        `title: ${page.title}`,
        `content:\n${page.content.slice(0, MAX_PAGE_CHARS)}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
  return `Notion pages:\n${body}\n\nReturn JSON:
{
  "candidates": [
    {
      "pageId": "source page id",
      "title": "short candidate title",
      "type": "start|stop|change|pivot|archive",
      "subject": "decision subject",
      "reason": "why the decision was made",
      "context": "1 sentence context or null",
      "confidence": 0.0
    }
  ]
}`;
}

export interface NotionIngestDeps {
  llm: MemoryLlmClient;
  store: NotionCandidateStore;
  logger?: MemoryLogger;
}

export async function ingestNotionDecisionCandidates(
  params: { tenantId: string; pages: NotionPageInput[] },
  deps: NotionIngestDeps,
): Promise<NotionDecisionIngestResult> {
  const logger = deps.logger ?? NOOP_LOGGER;
  const pages = params.pages
    .filter((page) => page.content.trim())
    .slice(0, MAX_PAGES);
  if (!params.tenantId || pages.length === 0) {
    return { inserted: 0, candidates: [], reason: "invalid_payload" };
  }

  const parsed = await deps.llm.generateJson<{ candidates: unknown[] }>(
    SYSTEM_PROMPT,
    buildPrompt(pages),
    { candidates: [] },
    { maxTokens: 1200 },
  );
  const candidates = normalizeCandidates(parsed, pages);
  if (candidates.length === 0) {
    return { inserted: 0, candidates: [], reason: "no_candidates" };
  }

  const pageById = new Map(pages.map((page) => [page.id, page]));
  const rows: NotionCandidateRow[] = candidates.map((candidate) => {
    const page = pageById.get(candidate.pageId);
    return {
      tenantId: params.tenantId,
      source: "notion",
      sourceRef: candidate.pageId,
      sourceUrl: page?.url ?? null,
      title: candidate.title ?? page?.title ?? null,
      decisionType: candidate.type,
      subject: candidate.subject,
      reason: candidate.reason,
      context: candidate.context,
      confidence: candidate.confidence,
      status: "pending",
      rawPayload: {
        page: page?.raw ?? null,
        extractedBy: "notion-decision-candidates",
        lastEditedTime: page?.lastEditedTime ?? null,
      },
    };
  });

  const inserted = await deps.store.upsertCandidates(rows);
  if (inserted === null) {
    logger.error("notion-decision-candidates", new Error("upsert failed"));
    return { inserted: 0, candidates, reason: "db_error" };
  }

  return { inserted, candidates, reason: "inserted" };
}

// Internal exports for testing only.
export const __testing = { normalizeCandidates, buildPrompt };
