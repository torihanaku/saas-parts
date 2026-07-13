/**
 * Tests for notion-extractor.ts (ported from 実運用SaaS
 * tests/institutional-memory-notion-candidates.test.ts). LLM + candidate store
 * are injected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ingestNotionDecisionCandidates,
  parseNotionPages,
  type NotionCandidateStore,
  type NotionPageInput,
} from "./notion-extractor.js";
import type { MemoryLlmClient } from "./types.js";

const generateJson = vi.fn();
const upsertCandidates = vi.fn();

const llm: MemoryLlmClient = { generateJson };
const store: NotionCandidateStore = { upsertCandidates };

function tenNotionPages(): NotionPageInput[] {
  return Array.from({ length: 10 }, (_, index) => ({
    id: `page-${index + 1}`,
    title: `Weekly note ${index + 1}`,
    content:
      index % 3 === 0
        ? `決定: Campaign ${index + 1} を停止する。CPA が上限を超えたため。`
        : "進捗メモ。まだ検討中で、決定事項はない。",
    url: `https://notion.so/page-${index + 1}`,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  upsertCandidates.mockResolvedValue(3);
});

describe("ingestNotionDecisionCandidates", () => {
  it("extracts candidates and stores them pending", async () => {
    generateJson.mockResolvedValueOnce({
      candidates: [
        { pageId: "page-1", title: "Campaign 1 stop", type: "stop", subject: "Campaign 1", reason: "CPA が上限を超えたため", context: "週次メモ", confidence: 0.91 },
        { pageId: "page-4", title: "Campaign 4 stop", type: "stop", subject: "Campaign 4", reason: "CPA が上限を超えたため", context: "週次メモ", confidence: 0.88 },
        { pageId: "page-7", title: "Campaign 7 stop", type: "stop", subject: "Campaign 7", reason: "CPA が上限を超えたため", context: "週次メモ", confidence: 0.86 },
      ],
    });

    const result = await ingestNotionDecisionCandidates(
      { tenantId: "tenant-1", pages: tenNotionPages() },
      { llm, store },
    );

    expect(result.reason).toBe("inserted");
    expect(result.inserted).toBe(3);
    expect(result.candidates).toHaveLength(3);
    const rows = upsertCandidates.mock.calls[0]![0];
    expect(rows[0]).toMatchObject({
      tenantId: "tenant-1",
      source: "notion",
      sourceRef: "page-1",
      status: "pending",
      subject: "Campaign 1",
    });
  });

  it("returns no_candidates when the model finds nothing", async () => {
    generateJson.mockResolvedValueOnce({ candidates: [] });
    const result = await ingestNotionDecisionCandidates(
      { tenantId: "tenant-1", pages: tenNotionPages() },
      { llm, store },
    );
    expect(result.reason).toBe("no_candidates");
    expect(upsertCandidates).not.toHaveBeenCalled();
  });

  it("returns invalid_payload for empty pages", async () => {
    const result = await ingestNotionDecisionCandidates(
      { tenantId: "tenant-1", pages: [] },
      { llm, store },
    );
    expect(result.reason).toBe("invalid_payload");
  });

  it("returns db_error when the store fails", async () => {
    generateJson.mockResolvedValueOnce({
      candidates: [
        { pageId: "page-1", type: "stop", subject: "Campaign 1", reason: "r", confidence: 0.9 },
      ],
    });
    upsertCandidates.mockResolvedValueOnce(null);
    const result = await ingestNotionDecisionCandidates(
      { tenantId: "tenant-1", pages: tenNotionPages() },
      { llm, store },
    );
    expect(result.reason).toBe("db_error");
  });

  it("drops candidates below the min confidence or with unknown type", async () => {
    generateJson.mockResolvedValueOnce({
      candidates: [
        { pageId: "page-1", type: "stop", subject: "s", reason: "r", confidence: 0.4 }, // low
        { pageId: "page-1", type: "wat", subject: "s", reason: "r", confidence: 0.9 }, // bad type
      ],
    });
    const result = await ingestNotionDecisionCandidates(
      { tenantId: "tenant-1", pages: tenNotionPages() },
      { llm, store },
    );
    expect(result.reason).toBe("no_candidates");
  });
});

describe("parseNotionPages", () => {
  it("parses rich payloads (properties title + blocks) into page text", () => {
    const pages = parseNotionPages({
      results: [
        {
          id: "page-rich",
          url: "https://notion.so/page-rich",
          properties: {
            Name: { type: "title", title: [{ plain_text: "Launch Review" }] },
          },
          blocks: [
            { type: "paragraph", paragraph: { rich_text: [{ plain_text: "決定: LP を刷新する。" }] } },
          ],
        },
      ],
    });
    expect(pages).toEqual([
      expect.objectContaining({
        id: "page-rich",
        title: "Launch Review",
        content: "決定: LP を刷新する。",
      }),
    ]);
  });

  it("returns [] for non-object payloads", () => {
    expect(parseNotionPages(null)).toEqual([]);
    expect(parseNotionPages("nope")).toEqual([]);
  });
});
