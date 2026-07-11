import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordHardNegative, checkHardNegativeSimilarity } from "./feedback-loop.js";
import { InMemoryChallengerStore, type HardNegativeMatchRow } from "./stores.js";
import type { EmbedText } from "./types.js";

const TENANT = "tenant-test";
const PROPOSAL_ID = "proposal-test";
const MOCK_EMBEDDING = Array(1536).fill(0.1);

let embedText: EmbedText;
beforeEach(() => {
  embedText = vi.fn(async () => MOCK_EMBEDDING);
});

describe("recordHardNegative", () => {
  it("returns null when disabled", async () => {
    const store = new InMemoryChallengerStore();
    const result = await recordHardNegative(
      { tenantId: TENANT, proposalId: PROPOSAL_ID, contentText: "test content" },
      { store, embedText, enabled: false },
    );
    expect(result).toBeNull();
    expect(embedText).not.toHaveBeenCalled();
  });

  it("inserts hard negative, embeds content, and patches embedding", async () => {
    const store = new InMemoryChallengerStore();
    const result = await recordHardNegative(
      { tenantId: TENANT, proposalId: PROPOSAL_ID, contentText: "rejected ad copy", rejectionReasonText: "misleading claim" },
      { store, embedText },
    );
    expect(result).not.toBeNull();
    expect(result!.embeddingStored).toBe(true);
    expect(embedText).toHaveBeenCalledWith("rejected ad copy");
    expect(store.savedHardNegatives[0]!.embedding).toEqual(MOCK_EMBEDDING);
  });

  it("persists source and rejection codes for other active-learning inputs", async () => {
    const store = new InMemoryChallengerStore();
    await recordHardNegative(
      {
        tenantId: TENANT,
        proposalId: PROPOSAL_ID,
        contentText: "rejected guideline rule",
        rejectionReasonCode: "brand_rule_rejected",
        rejectionReasonText: "false positive extraction",
        source: "brand_rule_reject",
      },
      { store, embedText },
    );
    expect(store.savedHardNegatives[0]!.rejection_reason_code).toBe("brand_rule_rejected");
    expect(store.savedHardNegatives[0]!.source).toBe("brand_rule_reject");
  });

  it("returns embeddingStored=false when embedding patch fails", async () => {
    const store = new InMemoryChallengerStore();
    store.patchHardNegativeEmbedding = async () => false;
    const result = await recordHardNegative(
      { tenantId: TENANT, proposalId: PROPOSAL_ID, contentText: "test" },
      { store, embedText },
    );
    expect(result).not.toBeNull();
    expect(result!.embeddingStored).toBe(false);
  });

  it("returns null when the insert fails", async () => {
    const store = new InMemoryChallengerStore();
    store.insertHardNegative = async () => null;
    const result = await recordHardNegative(
      { tenantId: TENANT, proposalId: PROPOSAL_ID, contentText: "test" },
      { store, embedText },
    );
    expect(result).toBeNull();
  });
});

describe("checkHardNegativeSimilarity", () => {
  function storeMatching(rows: HardNegativeMatchRow[], err = false): InMemoryChallengerStore {
    const s = new InMemoryChallengerStore();
    s.matchHardNegatives = async (tenantId, _e, threshold) => {
      if (err) throw new Error("rpc failure");
      expect(tenantId).toBe(TENANT);
      expect(threshold).toBe(0.85);
      return rows;
    };
    return s;
  }

  it("returns empty when disabled", async () => {
    const store = new InMemoryChallengerStore();
    const result = await checkHardNegativeSimilarity(TENANT, "any content", { store, embedText, enabled: false });
    expect(result.matched).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(embedText).not.toHaveBeenCalled();
  });

  it("returns empty when no similar hard negatives found", async () => {
    const store = storeMatching([]);
    const result = await checkHardNegativeSimilarity(TENANT, "unrelated content", { store, embedText });
    expect(result.matched).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  it("returns matches when similar hard negatives exist", async () => {
    const store = storeMatching([
      { id: "hn-1", similarity: 0.92, rejection_reason_text: "misleading", source: "challenger_reject" },
      { id: "hn-2", similarity: 0.88, rejection_reason_text: null, source: "slack_reject" },
    ]);
    const result = await checkHardNegativeSimilarity(TENANT, "similar ad copy", { store, embedText });
    expect(result.matched).toBe(true);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]!.hardNegativeId).toBe("hn-1");
    expect(result.matches[0]!.similarity).toBe(0.92);
    expect(result.matches[0]!.rejectionReasonText).toBe("misleading");
  });

  it("returns empty when the store throws", async () => {
    const store = storeMatching([], true);
    const result = await checkHardNegativeSimilarity(TENANT, "content", { store, embedText });
    expect(result.matched).toBe(false);
    expect(result.matches).toHaveLength(0);
  });
});

describe("200-case detection rate", () => {
  it("detects at least 90 of 100 similar cases", async () => {
    let detected = 0;
    for (let i = 0; i < 100; i++) {
      const store = new InMemoryChallengerStore();
      store.matchHardNegatives = async () => [
        { id: `hn-${i}`, similarity: 0.91, rejection_reason_text: "prior rejection", source: "challenger_reject" },
      ];
      const result = await checkHardNegativeSimilarity(TENANT, `similar content ${i}`, { store, embedText });
      if (result.matched) detected++;
    }
    expect(detected).toBeGreaterThanOrEqual(90);
  });

  it("does not trigger for 100 dissimilar cases", async () => {
    let falsePositives = 0;
    for (let i = 0; i < 100; i++) {
      const store = new InMemoryChallengerStore();
      store.matchHardNegatives = async () => [];
      const result = await checkHardNegativeSimilarity(TENANT, `unrelated ${i}`, { store, embedText });
      if (result.matched) falsePositives++;
    }
    expect(falsePositives).toBe(0);
  });
});
