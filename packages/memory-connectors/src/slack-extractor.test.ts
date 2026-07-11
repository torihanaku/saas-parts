/**
 * Tests for slack-extractor.ts. LLM, store, and consent are injected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractDecisionFromSlack,
  slackCandidate,
  type SlackExtractStore,
} from "./slack-extractor.js";
import type { MemoryLlmClient } from "./types.js";

const generateJson = vi.fn();
const insertExtractedDecision = vi.fn();
const hasConsent = vi.fn();

const llm: MemoryLlmClient = { generateJson };
const store: SlackExtractStore = { insertExtractedDecision };

const input = {
  tenantId: "t1",
  slackPermalink: "https://slack.com/archives/C1/p1",
  slackChannel: "#growth",
  rawText: "Facebook 広告を停止します。CPA が高すぎるため。",
};

beforeEach(() => {
  vi.clearAllMocks();
  hasConsent.mockResolvedValue(true);
  insertExtractedDecision.mockResolvedValue("row-1");
});

describe("extractDecisionFromSlack", () => {
  it("persists a found decision and returns its id", async () => {
    generateJson.mockResolvedValueOnce({
      found: true,
      type: "stop",
      subject: "Facebook 広告",
      reason: "CPA が高い",
      confidence: 0.8,
    });
    const res = await extractDecisionFromSlack(input, { llm, store, hasConsent });
    expect(res).toEqual({ extractedId: "row-1", skipped: false });
  });

  it("skips when consent is not granted", async () => {
    hasConsent.mockResolvedValueOnce(false);
    const res = await extractDecisionFromSlack(input, { llm, store, hasConsent });
    expect(res.skipped).toBe(true);
    expect(res.extractedId).toBeNull();
    expect(generateJson).not.toHaveBeenCalled();
  });

  it("skips when no decision is found", async () => {
    generateJson.mockResolvedValueOnce({ found: false });
    const res = await extractDecisionFromSlack(input, { llm, store, hasConsent });
    expect(res.skipped).toBe(true);
    expect(insertExtractedDecision).not.toHaveBeenCalled();
  });

  it("skips when the model returns the null fallback", async () => {
    generateJson.mockResolvedValueOnce(null);
    const res = await extractDecisionFromSlack(input, { llm, store, hasConsent });
    expect(res.skipped).toBe(true);
  });

  it("defaults confidence to 0.5 when absent", async () => {
    generateJson.mockResolvedValueOnce({ found: true, type: "stop", subject: "s" });
    await extractDecisionFromSlack(input, { llm, store, hasConsent });
    const row = insertExtractedDecision.mock.calls[0]![0];
    expect(row.confidence).toBe(0.5);
  });

  it("grants consent by default when no check is injected", async () => {
    generateJson.mockResolvedValueOnce({ found: false });
    const res = await extractDecisionFromSlack(input, { llm, store });
    expect(res.skipped).toBe(true);
    expect(generateJson).toHaveBeenCalledTimes(1);
  });
});

describe("slackCandidate", () => {
  it("builds a SourceCandidate matching the kit contract", () => {
    const c = slackCandidate({
      slackPermalink: "https://slack/p1",
      rawText: "hi",
      decidedAt: "2026-05-01T00:00:00Z",
    });
    expect(c).toEqual({
      sourceRef: "https://slack/p1",
      rawText: "hi",
      decidedAt: "2026-05-01T00:00:00Z",
    });
  });
});
