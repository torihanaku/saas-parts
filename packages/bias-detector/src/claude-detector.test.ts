/**
 * Tests for claude-detector.ts (ported from dev-dashboard-v2
 * tests/bias/claude-detector.test.ts). LLM + registry are injected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  detectBiasesClaudeV1,
  CLAUDE_DETECTOR_VERSION,
  CLAUDE_DETECTOR_THRESHOLD,
  __testing,
} from "./claude-detector.js";
import { defaultBiasRegistry, BiasRegistry } from "./registry.js";
import type { BiasLlmClient } from "./types.js";

const generateJson = vi.fn();
const llm: BiasLlmClient = { generateJson };

beforeEach(() => {
  vi.clearAllMocks();
});

const reg = defaultBiasRegistry;

describe("sanitiseDetections (claude-v1)", () => {
  it("drops unknown bias types and below-threshold detections", () => {
    const out = __testing.sanitiseDetections(
      [
        { biasType: "made_up", confidence: 0.99 },
        { biasType: "anchoring", confidence: CLAUDE_DETECTOR_THRESHOLD - 0.01 },
        { biasType: "anchoring", confidence: CLAUDE_DETECTOR_THRESHOLD + 0.01 },
      ],
      { subject: "S", reason: "R" },
      reg,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.biasType).toBe("anchoring");
    expect(out[0]!.detectorVersion).toBe(CLAUDE_DETECTOR_VERSION);
  });

  it("clamps confidence to [0, 1]", () => {
    const out = __testing.sanitiseDetections(
      [
        { biasType: "hippo", confidence: 1.7 },
        { biasType: "hippo", confidence: -0.4 },
      ],
      { subject: "S", reason: "R" },
      reg,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(1);
  });

  it("HiPPO bump: role=ceo + short reason raises confidence by 0.1", () => {
    const ctx = {
      subject: "Increase paid budget 10x",
      reason: "CEO 判断",
      decisionMakerRole: "ceo" as const,
    };
    const out = __testing.sanitiseDetections(
      [{ biasType: "hippo", confidence: CLAUDE_DETECTOR_THRESHOLD - 0.05 }],
      ctx,
      reg,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBeCloseTo(CLAUDE_DETECTOR_THRESHOLD + 0.05, 5);
    expect(out[0]!.decisionMakerRole).toBe("ceo");
  });

  it("HiPPO bump does NOT apply when reason is long even with C-level role", () => {
    const longReason =
      "ROI 計算と過去 3 ヶ月のデータで予測モデルを構築し合理的に判断した結果。これだけで 50 字超え。";
    const out = __testing.sanitiseDetections(
      [{ biasType: "hippo", confidence: CLAUDE_DETECTOR_THRESHOLD - 0.05 }],
      { subject: "S", reason: longReason, decisionMakerRole: "cmo" },
      reg,
    );
    expect(out).toHaveLength(0);
  });

  it("propagates decisionId from context", () => {
    const out = __testing.sanitiseDetections(
      [{ biasType: "anchoring", confidence: 0.8 }],
      {
        decisionId: "11111111-1111-1111-1111-111111111111",
        subject: "S",
        reason: "R",
      },
      reg,
    );
    expect(out[0]!.decisionId).toBe("11111111-1111-1111-1111-111111111111");
  });
});

describe("buildSystemPrompt + buildUserPrompt", () => {
  it("includes all 6 bias rubrics in the system prompt", () => {
    const sys = __testing.buildSystemPrompt(null, reg);
    expect(sys).toContain("sunk_cost");
    expect(sys).toContain("confirmation");
    expect(sys).toContain("recency");
    expect(sys).toContain("bandwagon");
    expect(sys).toContain("anchoring");
    expect(sys).toContain("hippo");
  });

  it("adds HiPPO weighting hint when role is ceo or cmo", () => {
    const sysCeo = __testing.buildSystemPrompt("ceo", reg);
    expect(sysCeo).toMatch(/重み付けヒント/);
    expect(sysCeo).toMatch(/CEO/);
    const sysCmo = __testing.buildSystemPrompt("cmo", reg);
    expect(sysCmo).toMatch(/CMO/);
  });

  it("does NOT add HiPPO hint for analyst / null role", () => {
    expect(__testing.buildSystemPrompt(null, reg)).not.toMatch(/重み付けヒント/);
    expect(__testing.buildSystemPrompt("analyst", reg)).not.toMatch(/重み付けヒント/);
  });

  it("user prompt includes subject and reason length and role", () => {
    const user = __testing.buildUserPrompt({
      subject: "X",
      reason: "Y",
      decisionMakerRole: "cmo",
    });
    expect(user).toContain("件名");
    expect(user).toContain("X");
    expect(user).toContain("字数");
    expect(user).toContain("決定者役職");
    expect(user).toContain("cmo");
  });
});

describe("detectBiasesClaudeV1", () => {
  it("calls the LLM once and tags every detection with detectorVersion", async () => {
    generateJson.mockResolvedValueOnce([
      { biasType: "sunk_cost", confidence: 0.85, recommendation: "Stop now" },
      { biasType: "confirmation", confidence: 0.72 },
    ]);

    const result = await detectBiasesClaudeV1(
      {
        subject: "Continue ad spend",
        reason: "Already invested",
        decisionMakerRole: "marketing_manager",
      },
      llm,
    );

    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.detectorVersion === CLAUDE_DETECTOR_VERSION)).toBe(true);
    expect(result.every((r) => r.decisionMakerRole === "marketing_manager")).toBe(true);
  });

  it("returns [] when the LLM returns the fallback", async () => {
    generateJson.mockResolvedValueOnce([]);
    const out = await detectBiasesClaudeV1({ subject: "S", reason: "R" }, llm);
    expect(out).toEqual([]);
  });
});

describe("BiasRegistry extensibility", () => {
  it("detects a custom-registered bias type", () => {
    const custom = new BiasRegistry().register({
      type: "loss_aversion",
      rubric: "## loss_aversion — custom",
    });
    expect(custom.has("loss_aversion")).toBe(true);
    const out = __testing.sanitiseDetections(
      [{ biasType: "loss_aversion", confidence: 0.9 }],
      { subject: "S", reason: "R" },
      custom,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.biasType).toBe("loss_aversion" as never);
  });
});
