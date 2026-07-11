/**
 * Tests for bias-detector.ts (ported from dev-dashboard-v2 tests/bias-detector.test.ts).
 * LLM is injected via a mock BiasLlmClient.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createBiasDetectorService,
  createLegacySingleShotDetector,
  BIAS_CONFIDENCE_THRESHOLD,
  __testing,
} from "./bias-detector.js";
import type { BiasLlmClient } from "./types.js";

const generateJson = vi.fn();
const llm: BiasLlmClient = { generateJson };

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── sanitiseDetections (pure unit, legacy single-shot) ─────────────────────

describe("sanitiseDetections", () => {
  it("returns [] for non-array input", () => {
    expect(__testing.sanitiseDetections(null)).toEqual([]);
    expect(__testing.sanitiseDetections({})).toEqual([]);
    expect(__testing.sanitiseDetections("not-array")).toEqual([]);
  });

  it("filters out unknown bias_type values", () => {
    const out = __testing.sanitiseDetections([
      { biasType: "made_up_bias", confidence: 0.9 },
      { biasType: "sunk_cost", confidence: 0.9 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.biasType).toBe("sunk_cost");
  });

  it("drops detections below the confidence threshold", () => {
    const out = __testing.sanitiseDetections([
      { biasType: "anchoring", confidence: BIAS_CONFIDENCE_THRESHOLD - 0.01 },
      { biasType: "anchoring", confidence: BIAS_CONFIDENCE_THRESHOLD + 0.01 },
    ]);
    expect(out).toHaveLength(1);
  });

  it("clamps confidence to [0, 1]", () => {
    const out = __testing.sanitiseDetections([
      { biasType: "hippo", confidence: 1.5 },
      { biasType: "hippo", confidence: -0.3 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(1);
  });

  it("normalises evidence to {} when not an object", () => {
    const out = __testing.sanitiseDetections([
      { biasType: "confirmation", confidence: 0.8, evidence: "not-an-object" },
    ]);
    expect(out[0]!.evidence).toEqual({});
  });

  it("normalises recommendation to null when missing or empty", () => {
    const out = __testing.sanitiseDetections([
      { biasType: "recency", confidence: 0.8, recommendation: "" },
      { biasType: "recency", confidence: 0.8 },
      { biasType: "recency", confidence: 0.8, recommendation: "Use 3-month trend" },
    ]);
    expect(out[0]!.recommendation).toBeNull();
    expect(out[1]!.recommendation).toBeNull();
    expect(out[2]!.recommendation).toBe("Use 3-month trend");
  });
});

// ─── buildUserPrompt (legacy) ────────────────────────────────────────────────

describe("buildUserPrompt", () => {
  it("includes subject and reason", () => {
    const text = __testing.buildUserPrompt({
      subject: "Continue ad campaign",
      reason: "Already spent 2M JPY",
    });
    expect(text).toContain("Continue ad campaign");
    expect(text).toContain("Already spent 2M JPY");
  });

  it("omits optional sections when not provided", () => {
    const text = __testing.buildUserPrompt({ subject: "S", reason: "R" });
    expect(text).not.toContain("## 状況");
    expect(text).not.toContain("## 検討した代替案");
    expect(text).not.toContain("## 履歴シグナル");
  });

  it("includes history JSON when provided", () => {
    const text = __testing.buildUserPrompt({
      subject: "S",
      reason: "R",
      history: { spend_jpy: 2_000_000, roi: -0.3 },
    });
    expect(text).toContain("spend_jpy");
    expect(text).toContain("-0.3");
  });
});

// ─── detectBiases happy path / edge cases (v1 detector via injected LLM) ─────

describe("createBiasDetectorService().detectBiases", () => {
  it("happy path: detects sunk_cost and propagates decisionId", async () => {
    generateJson.mockResolvedValueOnce([
      {
        biasType: "sunk_cost",
        confidence: 0.85,
        evidence: { spent_jpy: 2_000_000, roi: -0.3 },
        recommendation: "Stop based on ROI, not prior spend",
      },
    ]);

    const svc = createBiasDetectorService(llm);
    const result = await svc.detectBiases({
      decisionId: "11111111-1111-1111-1111-111111111111",
      subject: "Continue ad campaign",
      reason: "Already spent 2M JPY",
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.biasType).toBe("sunk_cost");
    expect(result[0]!.confidence).toBe(0.85);
    expect(result[0]!.decisionId).toBe("11111111-1111-1111-1111-111111111111");
    expect(result[0]!.recommendation).toContain("Stop");
  });

  it("returns [] when all detections fall below threshold", async () => {
    generateJson.mockResolvedValueOnce([
      { biasType: "hippo", confidence: 0.3 },
      { biasType: "anchoring", confidence: 0.4 },
    ]);
    const svc = createBiasDetectorService(llm);
    const result = await svc.detectBiases({
      subject: "Use last year's KPI as target",
      reason: "Same as last year",
    });
    expect(result).toEqual([]);
  });

  it("returns [] when the LLM returns the fallback (model failure / parse fail)", async () => {
    generateJson.mockResolvedValueOnce([]);
    const svc = createBiasDetectorService(llm);
    const result = await svc.detectBiases({ subject: "S", reason: "R" });
    expect(result).toEqual([]);
  });

  it("calls the LLM with a system prompt and a user prompt containing the subject", async () => {
    generateJson.mockResolvedValueOnce([]);
    const svc = createBiasDetectorService(llm);
    await svc.detectBiases({ subject: "Sample subject", reason: "Sample reason" });
    expect(generateJson).toHaveBeenCalledTimes(1);
    const [system, userPrompt] = generateJson.mock.calls[0]!;
    expect(typeof system).toBe("string");
    expect((system as string).length).toBeGreaterThan(50);
    expect(userPrompt).toContain("Sample subject");
    expect(userPrompt).toContain("Sample reason");
  });

  it("bumps HiPPO confidence for a short C-level reason", async () => {
    generateJson.mockResolvedValueOnce([
      { biasType: "hippo", confidence: 0.55 }, // below 0.6 threshold pre-bump
    ]);
    const svc = createBiasDetectorService(llm);
    const result = await svc.detectBiases({
      subject: "Rebrand now",
      reason: "CEO said so",
      decisionMakerRole: "ceo",
    });
    // 0.55 + 0.1 = 0.65 >= threshold
    expect(result).toHaveLength(1);
    expect(result[0]!.biasType).toBe("hippo");
    expect(result[0]!.confidence).toBeCloseTo(0.65, 5);
  });
});

// ─── legacy single-shot detector ─────────────────────────────────────────────

describe("createLegacySingleShotDetector().detectBiases", () => {
  it("propagates decisionId onto sanitised detections", async () => {
    generateJson.mockResolvedValueOnce([
      { biasType: "confirmation", confidence: 0.9 },
    ]);
    const svc = createLegacySingleShotDetector(llm);
    const result = await svc.detectBiases({
      decisionId: "dec-1",
      subject: "S",
      reason: "R",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.decisionId).toBe("dec-1");
  });
});
