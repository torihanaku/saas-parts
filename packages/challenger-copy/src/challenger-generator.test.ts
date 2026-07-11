import { describe, it, expect, vi } from "vitest";
import { generateChallengerProposals } from "./challenger-generator.js";
import { generateDualOptions } from "./dualOptions.js";
import { InMemoryChallengerStore } from "./stores.js";
import type { GenerateJson } from "./types.js";

function jsonReturning(value: unknown): GenerateJson {
  return (async () => value) as unknown as GenerateJson;
}

describe("generateChallengerProposals", () => {
  it("generates and saves proposals", async () => {
    const store = new InMemoryChallengerStore();
    const generateJson = jsonReturning({
      proposals: [
        {
          content: "Challenger Content",
          deviationAxis: "tone",
          hypothesizedUpside: "Better engagement",
          estimatedRisk: "medium",
          rationale: "Strategy A",
        },
      ],
    });

    const result = await generateChallengerProposals(
      { tenantId: "tenant-1", originalContent: "Original Content" },
      { store, generateJson },
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("Challenger Content");
    expect(result[0]!.deviationAxis).toBe("tone");
    expect(store.savedProposals).toHaveLength(1);
    expect(store.savedProposals[0]!.tenant_id).toBe("tenant-1");
    expect(store.savedProposals[0]!.deviation_axis).toBe("tone");
    // 同じ原稿ハッシュが保存される。
    expect(store.savedProposals[0]!.original_content_hash).toHaveLength(64);
  });

  it("returns empty array when the LLM yields no proposals", async () => {
    const store = new InMemoryChallengerStore();
    const result = await generateChallengerProposals(
      { tenantId: "t1", originalContent: "orig" },
      { store, generateJson: jsonReturning({ proposals: [] }) },
    );
    expect(result).toHaveLength(0);
    expect(store.savedProposals).toHaveLength(0);
  });

  it("passes challenger content through (camouflage handled by system prompt)", async () => {
    const store = new InMemoryChallengerStore();
    const result = await generateChallengerProposals(
      { tenantId: "t1", originalContent: "orig" },
      {
        store,
        generateJson: jsonReturning({
          proposals: [
            {
              content: "This is a bold alternative",
              deviationAxis: "tone",
              hypothesizedUpside: "Test",
              estimatedRisk: "low",
              rationale: "Reason",
            },
          ],
        }),
      },
    );
    expect(result[0]!.content).toBe("This is a bold alternative");
  });
});

describe("generateDualOptions", () => {
  it("generates safe and edgy options using DNA context", async () => {
    const store = new InMemoryChallengerStore();
    store.setBrandDna("tenant-1", { voice: { desc: "casual" }, tone: { style: "friendly" } });

    let capturedUser = "";
    const generateJson = (async (_system: string, user: string) => {
      capturedUser = user;
      return { safe: "無難な案", edgy: "挑戦的な案", rationale: "狙いの説明" };
    }) as unknown as GenerateJson;

    const result = await generateDualOptions("tenant-1", "元の原稿", { store, generateJson });
    expect(result.safe).toBe("無難な案");
    expect(result.edgy).toBe("挑戦的な案");
    expect(capturedUser).toContain("元の原稿");
    expect(capturedUser).toContain("casual");
  });

  it("falls back to original text when DNA is absent (still calls LLM)", async () => {
    const store = new InMemoryChallengerStore();
    const generateJson = (async (_s: string, _u: string, fallback: unknown) => fallback) as unknown as GenerateJson;
    const result = await generateDualOptions("t1", "原稿", { store, generateJson });
    expect(result.safe).toBe("原稿");
    expect(result.edgy).toBe("原稿");
  });
});
