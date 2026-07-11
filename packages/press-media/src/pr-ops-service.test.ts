/**
 * Tests for pr-ops-service (ported from dev-dashboard-v2).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { suggestTiming, generateStrategySummary } from "./pr-ops-service";
import type {
  PREvent,
  IndustryEvent,
  TimingSuggestion,
  StrategySummary,
} from "./pr-ops-service";
import type { GenerateJson } from "./llm";

const mockGenerateJson = vi.fn() as unknown as ReturnType<typeof vi.fn> & GenerateJson;

const SAMPLE_EVENTS: PREvent[] = [
  {
    id: "1",
    title: "New Product Launch",
    event_type: "press_release",
    scheduled_at: "2026-05-01T10:00:00Z",
    status: "planned",
    description: "Announcing our new AI product",
  },
  {
    id: "2",
    title: "CTO Interview",
    event_type: "interview",
    scheduled_at: "2026-05-15T14:00:00Z",
    status: "confirmed",
  },
];

const SAMPLE_INDUSTRY_EVENTS: IndustryEvent[] = [
  {
    id: "ie1",
    event_name: "AI Summit Tokyo",
    organizer: "Tech Events Inc",
    date_from: "2026-05-10",
    date_to: "2026-05-12",
    industry: "AI",
    relevance_score: 85,
  },
];

describe("suggestTiming", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns timing suggestion from generateJson", async () => {
    const expected: TimingSuggestion = {
      suggestedDate: "2026-05-20",
      reasoning: "Optimal window after AI Summit",
      avoidDates: ["2026-05-10", "2026-05-11", "2026-05-12"],
      confidence: 0.85,
    };
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce(expected);

    const result = await suggestTiming(mockGenerateJson, "test-key", {
      upcomingEvents: SAMPLE_EVENTS,
      industryEvents: SAMPLE_INDUSTRY_EVENTS,
    });

    expect(result.suggestedDate).toBe("2026-05-20");
    expect(result.reasoning).toBe("Optimal window after AI Summit");
    expect(result.avoidDates).toHaveLength(3);
    expect(result.confidence).toBe(0.85);
  });

  it("clamps confidence above 1.0 to 1.0", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      suggestedDate: "2026-06-01",
      reasoning: "test",
      avoidDates: [],
      confidence: 1.5,
    });

    const result = await suggestTiming(mockGenerateJson, "test-key", {
      upcomingEvents: [],
      industryEvents: [],
    });

    expect(result.confidence).toBe(1);
  });

  it("clamps confidence below 0 to 0", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      suggestedDate: "2026-06-01",
      reasoning: "test",
      avoidDates: [],
      confidence: -0.5,
    });

    const result = await suggestTiming(mockGenerateJson, "test-key", {
      upcomingEvents: [],
      industryEvents: [],
    });

    expect(result.confidence).toBe(0);
  });

  it("returns fallback when generateJson returns default", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      suggestedDate: "2026-06-01",
      reasoning: "Default suggestion: 1 week from now",
      avoidDates: [],
      confidence: 0.3,
    });

    const result = await suggestTiming(mockGenerateJson, "test-key", {
      upcomingEvents: [],
      industryEvents: [],
    });

    expect(result.reasoning).toContain("Default");
    expect(result.confidence).toBe(0.3);
  });

  it("includes past performance in prompt when provided", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      suggestedDate: "2026-05-20",
      reasoning: "test",
      avoidDates: [],
      confidence: 0.7,
    });

    await suggestTiming(mockGenerateJson, "test-key", {
      upcomingEvents: SAMPLE_EVENTS,
      industryEvents: [],
      pastPerformance: "Tuesday releases get 2x coverage",
    });

    const [, , userPrompt] = (mockGenerateJson as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(userPrompt).toContain("Tuesday releases get 2x coverage");
  });
});

describe("generateStrategySummary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns strategy summary from generateJson", async () => {
    const expected: StrategySummary = {
      summary: "Strong positioning in AI market",
      keyThemes: ["AI innovation", "Market expansion"],
      recommendations: ["Increase media outreach", "Target trade publications"],
      upcomingOpportunities: ["AI Summit speaking slot", "Year-end roundup articles"],
    };
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce(expected);

    const result = await generateStrategySummary(mockGenerateJson, "test-key", {
      events: SAMPLE_EVENTS,
      industryEvents: SAMPLE_INDUSTRY_EVENTS,
    });

    expect(result.summary).toBe("Strong positioning in AI market");
    expect(result.keyThemes).toHaveLength(2);
    expect(result.recommendations).toHaveLength(2);
    expect(result.upcomingOpportunities).toHaveLength(2);
  });

  it("returns fallback when no data available", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      summary: "Insufficient data to generate strategy summary.",
      keyThemes: [],
      recommendations: [],
      upcomingOpportunities: [],
    });

    const result = await generateStrategySummary(mockGenerateJson, "test-key", {
      events: [],
      industryEvents: [],
    });

    expect(result.summary).toContain("Insufficient");
    expect(result.keyThemes).toEqual([]);
  });

  it("includes event descriptions in prompt", async () => {
    (mockGenerateJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      summary: "test",
      keyThemes: [],
      recommendations: [],
      upcomingOpportunities: [],
    });

    await generateStrategySummary(mockGenerateJson, "test-key", {
      events: SAMPLE_EVENTS,
      industryEvents: SAMPLE_INDUSTRY_EVENTS,
    });

    const [, , userPrompt] = (mockGenerateJson as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(userPrompt).toContain("Announcing our new AI product");
    expect(userPrompt).toContain("AI Summit Tokyo");
  });
});

describe("type correctness", () => {
  it("PREvent has all required fields", () => {
    const event: PREvent = {
      id: "test",
      title: "Test",
      event_type: "press_release",
      scheduled_at: "2026-01-01T00:00:00Z",
      status: "planned",
    };
    expect(event.event_type).toBe("press_release");
    expect(event.status).toBe("planned");
  });

  it("IndustryEvent has all required fields", () => {
    const event: IndustryEvent = {
      id: "test",
      event_name: "Test Event",
      date_from: "2026-01-01",
      relevance_score: 75,
    };
    expect(event.relevance_score).toBe(75);
  });

  it("event_type values are valid", () => {
    const types: PREvent["event_type"][] = [
      "press_release", "interview", "conference", "webinar", "media_appearance",
    ];
    expect(types).toHaveLength(5);
  });

  it("status values are valid", () => {
    const statuses: PREvent["status"][] = ["planned", "confirmed", "completed", "cancelled"];
    expect(statuses).toHaveLength(4);
  });
});
