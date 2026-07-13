/**
 * Tests for claude-variant-generator.ts (ported from 実運用SaaS
 * tests/ab-testing/claude-variant-generator.test.ts). LLM + cost ledger are
 * injected via mocks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  generateClaudeVariants,
  VariantCostCapError,
  VARIANT_COUNT_CEILING,
  MONTHLY_COST_CAP_JPY,
  __testing,
  type VariantLlmClient,
  type VariantCostLedger,
} from "./claude-variant-generator.js";

const generateJson = vi.fn();
const getMonthlySpendJpy = vi.fn();
const recordSpend = vi.fn();

const llm: VariantLlmClient = { generateJson };
const ledger: VariantCostLedger = { getMonthlySpendJpy, recordSpend };
const deps = { llm, ledger };

beforeEach(() => {
  vi.clearAllMocks();
  getMonthlySpendJpy.mockResolvedValue(0);
  recordSpend.mockResolvedValue(undefined);
});

describe("generateClaudeVariants — happy path", () => {
  it("returns seeds after the LLM generates a valid array + records spend", async () => {
    generateJson.mockResolvedValueOnce([
      { label: "v1", subject: "First subject", body: "Body A", cta: "Click" },
      { label: "v2", subject: "Second subject", cta: "Buy" },
    ]);

    const seeds = await generateClaudeVariants(
      {
        tenantId: "t1",
        experimentId: "exp1",
        surface: "email_subject",
        targetMetric: "open_rate",
        count: 2,
      },
      deps,
    );

    expect(seeds).toHaveLength(2);
    expect(seeds[0]!.label).toBe("v1");
    expect(seeds[0]!.payload.subject).toBe("First subject");
    expect(seeds[0]!.source).toBe("ai");
    expect(recordSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        experimentId: "exp1",
        variantCount: 2,
      }),
    );
  });

  it("clamps count to VARIANT_COUNT_CEILING", async () => {
    const big = Array.from({ length: 60 }).map((_, i) => ({
      label: `v${i}`,
      subject: `Subject ${i}`,
    }));
    generateJson.mockResolvedValueOnce(big);

    const seeds = await generateClaudeVariants(
      {
        tenantId: "t1",
        experimentId: "exp1",
        surface: "email_subject",
        targetMetric: "open_rate",
        count: 100,
      },
      deps,
    );
    expect(seeds.length).toBeLessThanOrEqual(VARIANT_COUNT_CEILING);
  });
});

describe("generateClaudeVariants — guard rails", () => {
  it("raises VariantCostCapError when projected cost exceeds monthly cap", async () => {
    getMonthlySpendJpy.mockResolvedValueOnce(MONTHLY_COST_CAP_JPY - 10);

    await expect(
      generateClaudeVariants(
        {
          tenantId: "t1",
          experimentId: "exp1",
          surface: "email_subject",
          targetMetric: "open_rate",
          count: 50,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(VariantCostCapError);
    expect(generateJson).not.toHaveBeenCalled();
  });

  it("throws when the LLM returns no parseable variants", async () => {
    generateJson.mockResolvedValueOnce([{ /* missing subject */ }]);
    await expect(
      generateClaudeVariants(
        {
          tenantId: "t1",
          experimentId: "exp1",
          surface: "email_subject",
          targetMetric: "open_rate",
          count: 3,
        },
        deps,
      ),
    ).rejects.toThrow("claude_returned_no_variants");
  });

  it("still returns seeds when recordSpend throws (best-effort tracking)", async () => {
    generateJson.mockResolvedValueOnce([{ subject: "s1" }]);
    recordSpend.mockRejectedValueOnce(new Error("table missing"));
    const seeds = await generateClaudeVariants(
      {
        tenantId: "t1",
        experimentId: "exp1",
        surface: "email_subject",
        targetMetric: "open_rate",
        count: 2,
      },
      deps,
    );
    expect(seeds).toHaveLength(1);
  });
});

describe("sanitiseSeeds", () => {
  it("returns [] for non-array input", () => {
    expect(__testing.sanitiseSeeds(null, 10)).toEqual([]);
    expect(__testing.sanitiseSeeds("nope", 10)).toEqual([]);
    expect(__testing.sanitiseSeeds({ wrong: "shape" }, 10)).toEqual([]);
  });

  it("drops items missing subject", () => {
    const seeds = __testing.sanitiseSeeds(
      [{ label: "a" }, { subject: "ok subject" }],
      10,
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.payload.subject).toBe("ok subject");
  });

  it("caps to requested count", () => {
    const big = Array.from({ length: 20 }).map((_, i) => ({ subject: `s${i}` }));
    const seeds = __testing.sanitiseSeeds(big, 5);
    expect(seeds).toHaveLength(5);
  });

  it("auto-generates label when missing or whitespace", () => {
    const seeds = __testing.sanitiseSeeds(
      [{ subject: "s1" }, { label: "   ", subject: "s2" }],
      10,
    );
    expect(seeds[0]!.label).toBe("variant_1");
    expect(seeds[1]!.label).toBe("variant_2");
  });
});

describe("buildUserPrompt", () => {
  it("includes surface, targetMetric, count, brandVoice, axes", () => {
    const text = __testing.buildUserPrompt({
      tenantId: "t1",
      experimentId: "e1",
      surface: "lp_copy",
      targetMetric: "lp_ctr",
      count: 12,
      brandVoice: "Folia tone",
      axes: {
        tones: ["urgent", "playful"],
        lengths: ["short"],
        ctaStyles: ["benefit"],
      },
    });
    expect(text).toContain("lp_copy");
    expect(text).toContain("lp_ctr");
    expect(text).toContain("12 件");
    expect(text).toContain("Folia tone");
    expect(text).toContain("urgent");
    expect(text).toContain("playful");
    expect(text).toContain("short");
    expect(text).toContain("benefit");
  });
});
