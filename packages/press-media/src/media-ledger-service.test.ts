/**
 * Tests for media-ledger-service (ported from dev-dashboard-v2).
 * Covers: calculateRelationshipScore, suggestSortRule, generatePitchEmail
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  calculateRelationshipScore,
  suggestSortRule,
  generatePitchEmail,
  type MediaInteraction,
} from "./media-ledger-service";
import type { GenerateText } from "./llm";

const mockGenerateText = vi.fn() as unknown as ReturnType<typeof vi.fn> & GenerateText;

// ─── Helper: build interaction fixture ──────────────────────────────────────

function makeInteraction(
  overrides: Partial<MediaInteraction> = {},
): MediaInteraction {
  return {
    id: "ix-1",
    contact_id: "c-1",
    tenant_id: "t-1",
    interaction_type: "email_sent",
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

// ─── calculateRelationshipScore ─────────────────────────────────────────────

describe("calculateRelationshipScore", () => {
  it("returns all zeros for empty interactions", () => {
    const result = calculateRelationshipScore([]);
    expect(result).toEqual({
      recency: 0,
      frequency: 0,
      responseRate: 0,
      coverage: 0,
      total: 0,
    });
  });

  describe("recency dimension", () => {
    it("scores 30 for interaction within 30 days", () => {
      const result = calculateRelationshipScore([makeInteraction({ occurred_at: daysAgo(5) })]);
      expect(result.recency).toBe(30);
    });

    it("scores 20 for interaction within 31-60 days", () => {
      const result = calculateRelationshipScore([makeInteraction({ occurred_at: daysAgo(45) })]);
      expect(result.recency).toBe(20);
    });

    it("scores 10 for interaction within 61-90 days", () => {
      const result = calculateRelationshipScore([makeInteraction({ occurred_at: daysAgo(75) })]);
      expect(result.recency).toBe(10);
    });

    it("scores 0 for interaction older than 90 days", () => {
      const result = calculateRelationshipScore([makeInteraction({ occurred_at: daysAgo(120) })]);
      expect(result.recency).toBe(0);
    });
  });

  describe("frequency dimension", () => {
    it("counts interactions in last 6 months", () => {
      const interactions = Array.from({ length: 10 }, (_, i) =>
        makeInteraction({ id: `ix-${i}`, occurred_at: daysAgo(i * 10) }),
      );
      const result = calculateRelationshipScore(interactions);
      expect(result.frequency).toBe(10);
    });

    it("caps frequency at 30", () => {
      const interactions = Array.from({ length: 40 }, (_, i) =>
        makeInteraction({ id: `ix-${i}`, occurred_at: daysAgo(i) }),
      );
      const result = calculateRelationshipScore(interactions);
      expect(result.frequency).toBe(30);
    });

    it("excludes interactions older than 6 months", () => {
      const result = calculateRelationshipScore([makeInteraction({ occurred_at: daysAgo(200) })]);
      expect(result.frequency).toBe(0);
    });
  });

  describe("responseRate dimension", () => {
    it("scores 20 when all outreach has positive outcome", () => {
      const result = calculateRelationshipScore([
        makeInteraction({ interaction_type: "email_sent", outcome: "positive", occurred_at: daysAgo(5) }),
        makeInteraction({ id: "ix-2", interaction_type: "pitch_sent", outcome: "positive", occurred_at: daysAgo(10) }),
      ]);
      expect(result.responseRate).toBe(20);
    });

    it("scores 0 when no outreach exists", () => {
      const result = calculateRelationshipScore([
        makeInteraction({ interaction_type: "meeting", occurred_at: daysAgo(5) }),
      ]);
      expect(result.responseRate).toBe(0);
    });

    it("scores proportionally for mixed outcomes", () => {
      const result = calculateRelationshipScore([
        makeInteraction({ interaction_type: "email_sent", outcome: "positive", occurred_at: daysAgo(5) }),
        makeInteraction({ id: "ix-2", interaction_type: "email_sent", outcome: "negative", occurred_at: daysAgo(10) }),
      ]);
      expect(result.responseRate).toBe(10); // 1/2 * 20 = 10
    });

    it("ignores non-outreach types for response rate", () => {
      const result = calculateRelationshipScore([
        makeInteraction({ interaction_type: "email_sent", outcome: "positive", occurred_at: daysAgo(5) }),
        makeInteraction({ id: "ix-2", interaction_type: "call", outcome: "negative", occurred_at: daysAgo(10) }),
      ]);
      expect(result.responseRate).toBe(20); // only 1 outreach, 1 positive
    });
  });

  describe("coverage dimension", () => {
    it("scores 4 points per article_published", () => {
      const result = calculateRelationshipScore([
        makeInteraction({ interaction_type: "article_published", occurred_at: daysAgo(5) }),
      ]);
      expect(result.coverage).toBe(4);
    });

    it("caps coverage at 20 (5 articles)", () => {
      const interactions = Array.from({ length: 8 }, (_, i) =>
        makeInteraction({
          id: `ix-${i}`,
          interaction_type: "article_published",
          occurred_at: daysAgo(i * 10),
        }),
      );
      const result = calculateRelationshipScore(interactions);
      expect(result.coverage).toBe(20);
    });

    it("scores 0 when no articles exist", () => {
      const result = calculateRelationshipScore([
        makeInteraction({ interaction_type: "email_sent", occurred_at: daysAgo(5) }),
      ]);
      expect(result.coverage).toBe(0);
    });
  });

  it("sums all dimensions correctly", () => {
    const result = calculateRelationshipScore([
      makeInteraction({ interaction_type: "email_sent", outcome: "positive", occurred_at: daysAgo(5) }),
      makeInteraction({ id: "ix-2", interaction_type: "article_published", occurred_at: daysAgo(10) }),
    ]);
    expect(result.total).toBe(result.recency + result.frequency + result.responseRate + result.coverage);
    expect(result.total).toBe(30 + 2 + 20 + 4);
  });
});

// ─── suggestSortRule ────────────────────────────────────────────────────────

describe("suggestSortRule", () => {
  it("extracts domain from valid email", () => {
    const rule = suggestSortRule("tanaka@nikkei.com");
    expect(rule).toEqual({ ruleType: "email_domain", pattern: "@nikkei.com" });
  });

  it("returns null for empty string", () => {
    expect(suggestSortRule("")).toBeNull();
  });

  it("returns null for email without @", () => {
    expect(suggestSortRule("no-at-sign")).toBeNull();
  });

  it("handles email with subdomains", () => {
    const rule = suggestSortRule("editor@tech.asahi.co.jp");
    expect(rule).toEqual({ ruleType: "email_domain", pattern: "@tech.asahi.co.jp" });
  });
});

// ─── generatePitchEmail ─────────────────────────────────────────────────────

describe("generatePitchEmail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns parsed subject and body from Claude response", async () => {
    (mockGenerateText as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ subject: "AI新製品のご紹介", body: "田中様\n\n弊社の新製品についてご紹介させてください。" }),
    );

    const result = await generatePitchEmail(mockGenerateText, "test-key", {
      contactName: "田中太郎",
      outlet: "日経新聞",
      beat: "テクノロジー",
      pastInteractions: "email_sent: 前回の取材依頼 (2026-03-01)",
      topic: "AI新製品リリース",
    });

    expect(result.subject).toBe("AI新製品のご紹介");
    expect(result.body).toContain("田中様");
    expect(mockGenerateText).toHaveBeenCalledOnce();
  });

  it("returns raw text as body when JSON parsing fails", async () => {
    (mockGenerateText as ReturnType<typeof vi.fn>).mockResolvedValue("This is not JSON");

    const result = await generatePitchEmail(mockGenerateText, "test-key", {
      contactName: "Smith",
      outlet: "TechCrunch",
      beat: "startups",
      pastInteractions: "",
      topic: "New feature launch",
    });

    expect(result.subject).toBe("Pitch");
    expect(result.body).toBe("This is not JSON");
  });

  it("includes brand voice prompt when provided", async () => {
    (mockGenerateText as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ subject: "S", body: "B" }));

    await generatePitchEmail(mockGenerateText, "test-key", {
      contactName: "Editor",
      outlet: "Wired",
      beat: "tech",
      pastInteractions: "",
      topic: "Product launch",
      brandVoicePrompt: "Write in a bold, authoritative tone.",
    });

    const [, systemArg] = (mockGenerateText as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(systemArg).toContain("bold, authoritative tone");
  });

  it("handles empty response from Claude gracefully", async () => {
    (mockGenerateText as ReturnType<typeof vi.fn>).mockResolvedValue("");

    const result = await generatePitchEmail(mockGenerateText, "test-key", {
      contactName: "Test",
      outlet: "Test Outlet",
      beat: "general",
      pastInteractions: "",
      topic: "Test topic",
    });

    expect(result.subject).toBe("Pitch");
    expect(result.body).toBe("");
  });
});
