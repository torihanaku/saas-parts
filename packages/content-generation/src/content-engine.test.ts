import { describe, it, expect, vi } from "vitest";
import {
  CONTENT_TEMPLATES,
  TONE_GUIDE,
  templateToContentType,
  computeSeoScore,
  generateContent,
  generateReport,
  transformContent,
  extractActionItems,
} from "./content-engine.js";
import type { GenerateText } from "./types.js";

/** system/user/opts をキャプチャする LLM フェイク。 */
function fakeGenerateText(returnValue: string) {
  const calls: Array<{ system: string; user: string; opts?: { maxTokens?: number } }> = [];
  const fn: GenerateText = vi.fn(async (system, user, opts) => {
    calls.push({ system, user, opts });
    return returnValue;
  });
  return { fn, calls };
}

describe("CONTENT_TEMPLATES", () => {
  it("defines all required template keys", () => {
    const keys = ["trend-article", "thought-leadership", "how-to", "x-thread", "linkedin-post", "newsletter", "meeting-notes", "action-items", "summary"];
    for (const key of keys) expect(CONTENT_TEMPLATES[key]).toBeDefined();
  });
});

describe("TONE_GUIDE", () => {
  it("defines standard tone options", () => {
    expect(TONE_GUIDE.professional).toBeDefined();
    expect(TONE_GUIDE.casual).toBeDefined();
    expect(TONE_GUIDE.technical).toBeDefined();
  });
});

describe("templateToContentType", () => {
  it("maps x-thread to sns-x", () => expect(templateToContentType("x-thread")).toBe("sns-x"));
  it("maps linkedin-post to sns-linkedin", () => expect(templateToContentType("linkedin-post")).toBe("sns-linkedin"));
  it("maps newsletter to email", () => expect(templateToContentType("newsletter")).toBe("email"));
  it("maps action-items to action-items", () => expect(templateToContentType("action-items")).toBe("action-items"));
  it("maps meeting-notes to meeting-notes", () => expect(templateToContentType("meeting-notes")).toBe("meeting-notes"));
  it("maps summary to summary", () => expect(templateToContentType("summary")).toBe("summary"));
  it("maps unknown templates to article", () => expect(templateToContentType("trend-article")).toBe("article"));
});

describe("computeSeoScore", () => {
  it("returns a number between 0 and 100", () => {
    const score = computeSeoScore("Short content");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
  it("awards base score of 40 for empty content with no keyword", () => {
    expect(computeSeoScore("")).toBe(40);
  });
  it("gives higher score for long content", () => {
    expect(computeSeoScore("x".repeat(3000))).toBeGreaterThan(computeSeoScore("short"));
  });
  it("gives higher score with H2 headings", () => {
    const with3 = "## H1\ncontent\n## H2\ncontent\n## H3\ncontent";
    expect(computeSeoScore(with3)).toBeGreaterThan(computeSeoScore("no headings"));
  });
  it("gives higher score when keyword appears frequently", () => {
    expect(computeSeoScore("AI ".repeat(10), "AI")).toBeGreaterThan(computeSeoScore("no match", "AI"));
  });
  it("caps score at 100", () => {
    const rich = "## Heading\n".repeat(10) + "keyword ".repeat(20) + "x".repeat(3000);
    expect(computeSeoScore(rich, "keyword")).toBeLessThanOrEqual(100);
  });
});

describe("generateContent", () => {
  it("returns generated content with correct structure", async () => {
    const { fn } = fakeGenerateText("Generated article content here");
    const result = await generateContent(fn, { template: "trend-article", topic: "AI in marketing" });
    expect(result.content).toBe("Generated article content here");
    expect(result.contentType).toBe("article");
    expect(typeof result.seoScore).toBe("number");
  });

  it("uses professional tone by default", async () => {
    const { fn, calls } = fakeGenerateText("Content");
    await generateContent(fn, { template: "trend-article", topic: "Test" });
    expect(calls[0]!.system).toContain(TONE_GUIDE.professional);
  });

  it("uses specified tone", async () => {
    const { fn, calls } = fakeGenerateText("Content");
    await generateContent(fn, { template: "trend-article", topic: "Test", tone: "casual" });
    expect(calls[0]!.system).toContain(TONE_GUIDE.casual);
  });

  it("includes targetKeyword in system prompt", async () => {
    const { fn, calls } = fakeGenerateText("Content");
    await generateContent(fn, { template: "trend-article", topic: "Test", targetKeyword: "AI marketing" });
    expect(calls[0]!.system).toContain("AI marketing");
  });

  it("falls back to trend-article for unknown template", async () => {
    const { fn, calls } = fakeGenerateText("Content");
    await generateContent(fn, { template: "unknown", topic: "Test" });
    expect(calls[0]!.user).toContain(CONTENT_TEMPLATES["trend-article"]);
  });

  it("passes maxTokens to generateText", async () => {
    const { fn, calls } = fakeGenerateText("Content");
    await generateContent(fn, { template: "trend-article", topic: "Test", maxTokens: 3000 });
    expect(calls[0]!.opts?.maxTokens).toBe(3000);
  });
});

describe("generateReport", () => {
  it("returns report content", async () => {
    const { fn } = fakeGenerateText("# Weekly Summary");
    const result = await generateReport(fn, { template: "weekly-summary", dateFrom: "2024-01-01", dateTo: "2024-01-07" });
    expect(result).toContain("Weekly Summary");
  });

  it("includes date range in prompt", async () => {
    const { fn, calls } = fakeGenerateText("Report");
    await generateReport(fn, { template: "monthly-review", dateFrom: "2024-01-01", dateTo: "2024-01-31" });
    expect(calls[0]!.user).toContain("2024-01-01");
    expect(calls[0]!.user).toContain("2024-01-31");
  });

  it("includes focus areas and repos when provided", async () => {
    const { fn, calls } = fakeGenerateText("Report");
    await generateReport(fn, { template: "sprint-retro", dateFrom: "2024-01-01", dateTo: "2024-01-14", focusAreas: ["performance"], repos: ["frontend"] });
    expect(calls[0]!.user).toContain("performance");
    expect(calls[0]!.user).toContain("frontend");
  });

  it("maps weekly-summary to Japanese label", async () => {
    const { fn, calls } = fakeGenerateText("Report");
    await generateReport(fn, { template: "weekly-summary", dateFrom: "2024-01-01", dateTo: "2024-01-07" });
    expect(calls[0]!.user).toContain("週次サマリー");
  });

  it("uses template key for unknown template", async () => {
    const { fn, calls } = fakeGenerateText("Report");
    await generateReport(fn, { template: "custom-report", dateFrom: "2024-01-01", dateTo: "2024-01-31" });
    expect(calls[0]!.user).toContain("custom-report");
  });
});

describe("transformContent", () => {
  it("returns transformed content", async () => {
    const { fn } = fakeGenerateText("Thread post 1");
    const result = await transformContent(fn, { sourceContent: "Original article", instruction: "Xスレッドに変換して" });
    expect(result).toContain("Thread post 1");
  });

  it("includes instruction and source in prompt", async () => {
    const { fn, calls } = fakeGenerateText("Transformed");
    await transformContent(fn, { sourceContent: "Source text", instruction: "Convert to LinkedIn" });
    expect(calls[0]!.user).toContain("Convert to LinkedIn");
    expect(calls[0]!.user).toContain("Source text");
  });

  it("includes extraContext in system prompt", async () => {
    const { fn, calls } = fakeGenerateText("Transformed");
    await transformContent(fn, { sourceContent: "Src", instruction: "Convert", extraContext: "B2B audience" });
    expect(calls[0]!.system).toContain("B2B audience");
  });
});

describe("extractActionItems", () => {
  it("parses and returns action items from JSON response", async () => {
    const items = [{ title: "Write tests", owner: "Alice", due_date: "2024-01-15", priority: "high" }];
    const { fn } = fakeGenerateText(JSON.stringify(items));
    const result = await extractActionItems(fn, "Meeting transcript");
    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("Write tests");
  });

  it("returns empty array for non-JSON response", async () => {
    const { fn } = fakeGenerateText("Cannot extract");
    expect(await extractActionItems(fn, "text")).toEqual([]);
  });

  it("returns empty array for empty string", async () => {
    const { fn } = fakeGenerateText("");
    expect(await extractActionItems(fn, "text")).toEqual([]);
  });

  it("calls generateText with JSON instruction in system prompt", async () => {
    const { fn, calls } = fakeGenerateText("[]");
    await extractActionItems(fn, "text");
    expect(calls[0]!.system).toContain("JSON");
  });

  it("passes maxTokens of 2000", async () => {
    const { fn, calls } = fakeGenerateText("[]");
    await extractActionItems(fn, "text");
    expect(calls[0]!.opts?.maxTokens).toBe(2000);
  });
});
