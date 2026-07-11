/**
 * Tests for @torihanaku/legal-first-opinion (ported from dev-dashboard-v2).
 * claude-api-client / env を注入式 deps に置換。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  generateFirstOpinion,
  SUPPORTED_LAWS,
  STANDARD_DISCLAIMER,
  LAW_LABELS,
  type JpLawCode,
  type GenerateJson,
  type FirstOpinionDeps,
} from "./index";

const generateJsonMock = vi.fn();

function deps(overrides: Partial<FirstOpinionDeps> = {}): FirstOpinionDeps {
  return {
    generateJson: generateJsonMock as unknown as GenerateJson,
    resolveApiKey: () => "test-key",
    ...overrides,
  };
}

describe("Legal First-Opinion Agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns one opinion per supported law by default", async () => {
    generateJsonMock.mockResolvedValue({ violated: false, reasoning: "問題なし" });

    const result = await generateFirstOpinion(deps(), { contentText: "提案文" });
    expect(result.opinions).toHaveLength(SUPPORTED_LAWS.length);
    const codes = result.opinions.map((o) => o.law);
    for (const law of SUPPORTED_LAWS) expect(codes).toContain(law);
    expect(result.fromAi).toBe(true);
  });

  it("limits opinions to requested laws when subset is given", async () => {
    generateJsonMock.mockResolvedValue({ violated: true, reasoning: "違反の可能性" });
    const result = await generateFirstOpinion(deps(), {
      contentText: "提案文",
      laws: ["yakki", "keihyo"],
    });
    expect(result.opinions).toHaveLength(2);
    expect(result.opinions.map((o) => o.law)).toEqual(["yakki", "keihyo"]);
  });

  it("always attaches the standard disclaimer to every opinion", async () => {
    generateJsonMock
      .mockResolvedValueOnce({ violated: true, reasoning: "違反" })
      .mockResolvedValueOnce({ violated: false, reasoning: "" })
      .mockRejectedValueOnce(new Error("anthropic 503"))
      .mockResolvedValueOnce({ violated: false, reasoning: "問題なし" });

    const result = await generateFirstOpinion(deps(), { contentText: "x" });
    for (const op of result.opinions) {
      expect(op.disclaimer).toBe(STANDARD_DISCLAIMER);
      expect(op.reasoning.length).toBeGreaterThan(0);
    }
    expect(result.fromAi).toBe(false);
  });

  it("falls back to per-law fallback when AI throws", async () => {
    generateJsonMock.mockRejectedValue(new Error("network down"));
    const result = await generateFirstOpinion(deps(), {
      contentText: "x",
      laws: ["yakki"],
    });
    expect(result.opinions).toHaveLength(1);
    expect(result.opinions[0]!.violated).toBe(false);
    expect(result.opinions[0]!.reasoning).toMatch(/弁護士|法務/);
    expect(result.opinions[0]!.disclaimer).toBe(STANDARD_DISCLAIMER);
    expect(result.fromAi).toBe(false);
  });

  it("handles AI returning unexpected types gracefully", async () => {
    generateJsonMock.mockResolvedValueOnce({ violated: "yes", reasoning: 42 });
    const result = await generateFirstOpinion(deps(), {
      contentText: "x",
      laws: ["yakki"],
    });
    expect(result.opinions[0]!.violated).toBe(false);
    expect(result.opinions[0]!.reasoning).toBe(STANDARD_DISCLAIMER);
  });

  it("returns full fallback set when no api key resolves", async () => {
    const result = await generateFirstOpinion(deps({ resolveApiKey: () => "" }), { contentText: "x" });
    expect(generateJsonMock).not.toHaveBeenCalled();
    expect(result.opinions).toHaveLength(SUPPORTED_LAWS.length);
    expect(result.fromAi).toBe(false);
    for (const op of result.opinions) {
      expect(op.disclaimer).toBe(STANDARD_DISCLAIMER);
    }
  });

  it("resolves BYOK key from tenantId", async () => {
    generateJsonMock.mockResolvedValue({ violated: false, reasoning: "OK" });
    const resolveApiKey = vi.fn((tenantId: string | undefined) =>
      tenantId === "t-1" ? "tenant-key" : "",
    );
    await generateFirstOpinion(deps({ resolveApiKey }), { contentText: "x", laws: ["yakki"], tenantId: "t-1" });
    expect(resolveApiKey).toHaveBeenCalledWith("t-1");
    expect(generateJsonMock).toHaveBeenCalledWith(
      "tenant-key",
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("ignores unsupported law codes in input", async () => {
    generateJsonMock.mockResolvedValue({ violated: false, reasoning: "OK" });
    const result = await generateFirstOpinion(deps(), {
      contentText: "x",
      laws: ["yakki", "unsupported" as unknown as JpLawCode],
    });
    expect(result.opinions).toHaveLength(1);
    expect(result.opinions[0]!.law).toBe("yakki");
  });

  it("populates lawLabel using LAW_LABELS map", async () => {
    generateJsonMock.mockResolvedValue({ violated: false, reasoning: "OK" });
    const result = await generateFirstOpinion(deps(), {
      contentText: "x",
      laws: ["keihyo"],
    });
    expect(result.opinions[0]!.lawLabel).toBe(LAW_LABELS.keihyo);
  });
});
