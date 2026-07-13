/**
 * Ported from 実運用SaaS server/__tests__/multi-channel-summarizer.test.ts.
 * vi.mock (claude-api-client / tenant-secrets / env) を config 注入に置換。
 * BYOK の tenant secret → env fallback カスケードは resolveApiKey 注入側の
 * 責務になったため、キーゲート挙動 (解決成功 / null / throw) として移植。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createChannelSummarizer,
  normaliseActionItems,
  clampSummary,
  type ChannelInput,
} from "./index";

const generateJsonMock = vi.fn();
const resolveApiKeyMock = vi.fn();

function makeSummarizer(overrides: Partial<Parameters<typeof createChannelSummarizer>[0]> = {}) {
  return createChannelSummarizer({
    generateJson: (...args: unknown[]) =>
      generateJsonMock(...args) as Promise<never>,
    resolveApiKey: (tenantId: string) => resolveApiKeyMock(tenantId) as Promise<string | null>,
    logger: () => {},
    ...overrides,
  });
}

const slackInput: ChannelInput = {
  type: "slack",
  content: "@taro 来週リリース予定。レビュー Bob 担当。",
};
const emailInput: ChannelInput = {
  type: "email",
  content: "Subject: Q3 PMF\nBob → Taro\n来週金曜までに ROI シート提出。",
};

describe("summarizeMultiChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveApiKeyMock.mockResolvedValue("test-api-key");
  });

  it("merges Slack + Email into a unified summary", async () => {
    generateJsonMock.mockResolvedValueOnce({
      summary: "来週金曜リリース。Bob がレビュー、Taro が ROI シート提出担当。",
      actionItems: [
        { text: "ROI シート提出", owner: "Taro", due: "2026-05-09" },
        { text: "リリースレビュー", owner: "Bob" },
      ],
    });

    const summarizer = makeSummarizer();
    const result = await summarizer.summarizeMultiChannel([slackInput, emailInput], "tenant-1");

    expect(result.summary).toContain("リリース");
    expect(result.actionItems).toHaveLength(2);
    expect(result.actionItems[0]).toEqual({
      text: "ROI シート提出",
      owner: "Taro",
      due: "2026-05-09",
    });
    expect(result.sources).toEqual([slackInput, emailInput]);
  });

  it("normalises action items array (strips invalid entries, trims fields)", async () => {
    generateJsonMock.mockResolvedValueOnce({
      summary: "test",
      actionItems: [
        { text: "  valid task  ", owner: "  Alice  " },
        { text: "" }, // empty text → drop
        { owner: "no text" }, // no text → drop
        "string entry", // wrong type → drop
        { text: "due field test", due: "2026-06-01" },
      ],
    });

    const result = await makeSummarizer().summarizeMultiChannel([slackInput], "tenant-1");

    expect(result.actionItems).toHaveLength(2);
    expect(result.actionItems[0]).toEqual({ text: "valid task", owner: "Alice" });
    expect(result.actionItems[1]).toEqual({ text: "due field test", due: "2026-06-01" });
  });

  it("passes the resolved API key and prompt to the injected generateJson", async () => {
    resolveApiKeyMock.mockResolvedValueOnce("byok-tenant-key");
    generateJsonMock.mockResolvedValueOnce({ summary: "ok", actionItems: [] });

    await makeSummarizer().summarizeMultiChannel([slackInput], "tenant-1");

    expect(resolveApiKeyMock).toHaveBeenCalledWith("tenant-1");
    expect(generateJsonMock).toHaveBeenCalledWith(
      "byok-tenant-key",
      expect.any(String),
      expect.stringContaining("Slack"),
      expect.objectContaining({ summary: "", actionItems: [] }),
      expect.objectContaining({ maxTokens: 1200 }),
    );
  });

  it("skips the key gate when resolveApiKey is omitted", async () => {
    generateJsonMock.mockResolvedValueOnce({ summary: "ok", actionItems: [] });
    const summarizer = createChannelSummarizer({
      generateJson: (...args: unknown[]) => generateJsonMock(...args) as Promise<never>,
    });

    const result = await summarizer.summarizeMultiChannel([emailInput], "tenant-2");

    expect(result.summary).toBe("ok");
    expect(generateJsonMock).toHaveBeenCalledWith(
      "",
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("returns empty fallback when generateJson resolves to fallback shape", async () => {
    // generateJson 実装は失敗時に fallback を返す想定。それを再現する。
    generateJsonMock.mockResolvedValueOnce({ summary: "", actionItems: [] });

    const result = await makeSummarizer().summarizeMultiChannel([slackInput, emailInput], "tenant-1");

    expect(result.summary).toBe("");
    expect(result.actionItems).toEqual([]);
    expect(result.sources).toEqual([slackInput, emailInput]);
  });

  it("returns empty result when generateJson throws (defence-in-depth)", async () => {
    generateJsonMock.mockRejectedValueOnce(new Error("api down"));

    const result = await makeSummarizer().summarizeMultiChannel([slackInput], "tenant-1");

    expect(result).toEqual({ summary: "", actionItems: [], sources: [slackInput] });
  });

  it("returns empty result for empty input array without calling AI", async () => {
    const result = await makeSummarizer().summarizeMultiChannel([], "tenant-1");

    expect(result).toEqual({ summary: "", actionItems: [], sources: [] });
    expect(generateJsonMock).not.toHaveBeenCalled();
    expect(resolveApiKeyMock).not.toHaveBeenCalled();
  });

  it("returns empty result when resolveApiKey yields no key (BYOK gate)", async () => {
    resolveApiKeyMock.mockResolvedValueOnce(null);

    const result = await makeSummarizer().summarizeMultiChannel([slackInput], "tenant-1");

    expect(result.summary).toBe("");
    expect(result.actionItems).toEqual([]);
    expect(generateJsonMock).not.toHaveBeenCalled();
  });

  it("returns empty result when resolveApiKey throws", async () => {
    resolveApiKeyMock.mockRejectedValueOnce(new Error("vault down"));

    const result = await makeSummarizer().summarizeMultiChannel([slackInput], "tenant-1");

    expect(result).toEqual({ summary: "", actionItems: [], sources: [slackInput] });
    expect(generateJsonMock).not.toHaveBeenCalled();
  });

  it("clamps over-long summary to 200 chars with ellipsis", async () => {
    const long = "あ".repeat(500);
    generateJsonMock.mockResolvedValueOnce({ summary: long, actionItems: [] });

    const result = await makeSummarizer().summarizeMultiChannel([slackInput], "tenant-1");

    expect(result.summary.length).toBeLessThanOrEqual(200);
    expect(result.summary.endsWith("…")).toBe(true);
  });

  it("includes transcript channel with proper label in prompt (#1156)", async () => {
    generateJsonMock.mockResolvedValueOnce({
      summary: "transcript merged",
      actionItems: [{ text: "follow up" }],
    });

    const transcriptInput: ChannelInput = { type: "transcript", content: "Bob: 来週デプロイ\nAlice: 了解" };
    await makeSummarizer().summarizeMultiChannel([slackInput, transcriptInput], "tenant-1");

    const promptArg = generateJsonMock.mock.calls[0]?.[2] as string;
    expect(promptArg).toContain("Transcript (会議録画)");
    expect(promptArg).toContain("Bob:");
  });

  it("truncates transcript content over 6000 chars (#1156)", async () => {
    generateJsonMock.mockResolvedValueOnce({ summary: "ok", actionItems: [] });

    const huge = "a".repeat(7000);
    const transcriptInput: ChannelInput = { type: "transcript", content: huge };
    await makeSummarizer().summarizeMultiChannel([transcriptInput], "tenant-1");

    const promptArg = generateJsonMock.mock.calls[0]?.[2] as string;
    expect(promptArg).toContain("…(以下省略)");
    // transcript-specific cap is 6000
    const sourceBlock = promptArg.split("### Source 1")[1] ?? "";
    const aSlice = sourceBlock.match(/a+/)?.[0] ?? "";
    expect(aSlice.length).toBeLessThanOrEqual(6000);
  });

  it("labels unknown channel types with the raw type string and default cap", async () => {
    generateJsonMock.mockResolvedValueOnce({ summary: "ok", actionItems: [] });

    const crmInput: ChannelInput = { type: "crm", content: "x".repeat(5000) };
    await makeSummarizer().summarizeMultiChannel([crmInput], "tenant-1");

    const promptArg = generateJsonMock.mock.calls[0]?.[2] as string;
    expect(promptArg).toContain("— crm");
    expect(promptArg).toContain("…(以下省略)"); // default cap 4000
  });

  it("honours custom channelLabels / maxContentChars config", async () => {
    generateJsonMock.mockResolvedValueOnce({ summary: "ok", actionItems: [] });

    const summarizer = makeSummarizer({
      channelLabels: { crm: "CRM (商談メモ)" },
      maxContentChars: { crm: 100 },
    });
    await summarizer.summarizeMultiChannel([{ type: "crm", content: "y".repeat(200) }], "tenant-1");

    const promptArg = generateJsonMock.mock.calls[0]?.[2] as string;
    expect(promptArg).toContain("CRM (商談メモ)");
    const body = promptArg.split("\n")[1] ?? "";
    expect(body.length).toBeLessThanOrEqual(100 + "…(以下省略)".length);
  });
});

describe("helpers", () => {
  it("normaliseActionItems returns [] for non-array input", () => {
    expect(normaliseActionItems(null)).toEqual([]);
    expect(normaliseActionItems("x")).toEqual([]);
  });

  it("clampSummary returns '' for non-string input", () => {
    expect(clampSummary(undefined)).toBe("");
    expect(clampSummary(42)).toBe("");
  });
});
