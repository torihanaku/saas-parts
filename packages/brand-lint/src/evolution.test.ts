import { describe, it, expect, vi } from "vitest";
import { ingestRecentRejections } from "./hardNegativesEmbedder.js";
import { runRuleEvolution } from "./lintRuleEvolution.js";
import { InMemoryBrandLintStore } from "./stores.js";
import type { EmbedBatch, GenerateJson } from "./types.js";

const ONE_DAY = 1000 * 60 * 60 * 24;

describe("ingestRecentRejections", () => {
  it("embeds and inserts new rejections, skipping duplicates", async () => {
    const store = new InMemoryBrandLintStore();
    store.addRejection({ id: "s1", tenant_id: "t1", content_text: "bad copy 1", rejection_reason_text: "misleading" });
    store.addRejection({ id: "s2", tenant_id: "t1", content_text: "bad copy 2" });

    const embedBatch: EmbedBatch = vi.fn(async (texts) => texts.map(() => [0.1, 0.2, 0.3]));
    const result = await ingestRecentRejections(7, { store, embedBatch });

    expect(result.inserted).toBe(2);
    expect(embedBatch).toHaveBeenCalledWith(["bad copy 1", "bad copy 2"]);

    // Second run: already ingested → no new inserts.
    const result2 = await ingestRecentRejections(7, { store, embedBatch });
    expect(result2.inserted).toBe(0);
  });

  it("returns 0 when there are no rejections", async () => {
    const store = new InMemoryBrandLintStore();
    const embedBatch: EmbedBatch = vi.fn(async () => []);
    expect((await ingestRecentRejections(7, { store, embedBatch })).inserted).toBe(0);
    expect(embedBatch).not.toHaveBeenCalled();
  });
});

describe("runRuleEvolution", () => {
  it("clusters recent rejections into rule proposals via the injected LLM", async () => {
    const store = new InMemoryBrandLintStore();
    const nowIso = (daysAgo: number) => new Date(Date.now() - daysAgo * ONE_DAY).toISOString();
    store.addRejectedSnapshot({ id: "sn1", tenant_id: "t1", content_text: "最安値保証", rejection_reason: "最上級表現", created_at: nowIso(5) });
    store.addRejectedSnapshot({ id: "sn2", tenant_id: "t1", content_text: "業界No.1", rejection_reason: "無根拠の順位", created_at: nowIso(10) });
    // Ancient one (past HARD_CUTOFF) must be ignored.
    store.addRejectedSnapshot({ id: "old", tenant_id: "t1", content_text: "legacy", rejection_reason: "old", created_at: nowIso(400) });

    const generateJson: GenerateJson = vi.fn(async () => ({
      rules: [
        { proposed_rule_key: "no_superlatives", description_ja: "最上級表現の禁止", pattern: "最安, 最速, No.1", pattern_type: "keyword", severity: "error" },
      ],
    })) as unknown as GenerateJson;

    const result = await runRuleEvolution({ store, generateJson });
    expect(result.proposals).toBe(1);
    expect(store.proposals).toHaveLength(1);
    expect(store.proposals[0]!.proposed_rule_key).toBe("no_superlatives");
    // Evidence must exclude the ancient snapshot.
    expect(store.proposals[0]!.evidence_snapshot_ids).toEqual(["sn1", "sn2"]);
  });

  it("skips incomplete rule objects", async () => {
    const store = new InMemoryBrandLintStore();
    store.addRejectedSnapshot({ id: "sn1", tenant_id: "t1", content_text: "x", rejection_reason: "r", created_at: new Date().toISOString() });
    const generateJson: GenerateJson = vi.fn(async () => ({
      rules: [{ proposed_rule_key: "incomplete" }],
    })) as unknown as GenerateJson;
    const result = await runRuleEvolution({ store, generateJson });
    expect(result.proposals).toBe(0);
  });

  it("returns 0 proposals when no tenants / snapshots", async () => {
    const store = new InMemoryBrandLintStore();
    const generateJson = vi.fn() as unknown as GenerateJson;
    expect((await runRuleEvolution({ store, generateJson })).proposals).toBe(0);
    expect(generateJson).not.toHaveBeenCalled();
  });
});
