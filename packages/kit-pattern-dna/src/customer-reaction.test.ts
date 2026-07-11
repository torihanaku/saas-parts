/**
 * 出典テスト: dev-dashboard-v2 tests/company-dna-customer-reaction.test.ts
 * （コア部分を移植。Supabase モック → InMemoryDnaStore）。
 */
import { describe, it, expect } from "vitest";
import {
  clampEngagement,
  getReactionMatrix,
  parseReactionKey,
  reactionKey,
  recommendBestMessage,
  recordReaction,
  validateRecordInput,
} from "./customer-reaction.js";
import { InMemoryDnaStore } from "./stores.js";

const TENANT = "tenant-1";

describe("reactionKey / parseReactionKey", () => {
  it("round-trips variant + segment", () => {
    const key = reactionKey("variant-a", "smb");
    expect(key).toBe("variant-a::smb");
    expect(parseReactionKey(key)).toEqual({ messageVariant: "variant-a", segment: "smb" });
  });

  it("returns null for malformed keys", () => {
    expect(parseReactionKey("no-separator")).toBeNull();
    expect(parseReactionKey("::leading")).toBeNull();
    expect(parseReactionKey("trailing::")).toBeNull();
  });

  it("keeps separators inside the segment (first :: wins)", () => {
    expect(parseReactionKey("a::b::c")).toEqual({ messageVariant: "a", segment: "b::c" });
  });
});

describe("clampEngagement", () => {
  it("clamps to [0, 1] and maps non-finite to 0", () => {
    expect(clampEngagement(0.7)).toBe(0.7);
    expect(clampEngagement(-2)).toBe(0);
    expect(clampEngagement(5)).toBe(1);
    expect(clampEngagement("0.4")).toBe(0.4);
    expect(clampEngagement(NaN)).toBe(0);
  });
});

describe("validateRecordInput", () => {
  const valid = {
    tenantId: TENANT,
    messageVariant: " v1 ",
    segment: " smb ",
    engagement: 0.5,
  };

  it("normalises a valid payload (trim + default sample=1)", () => {
    const res = validateRecordInput(valid);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.messageVariant).toBe("v1");
    expect(res.value.segment).toBe("smb");
    expect(res.value.sample).toBe(1);
  });

  it("rejects missing tenant / variant / segment", () => {
    expect(validateRecordInput({ ...valid, tenantId: " " })).toEqual({
      ok: false, error: "tenant_required",
    });
    expect(validateRecordInput({ ...valid, messageVariant: "" })).toEqual({
      ok: false, error: "message_variant_required",
    });
    expect(validateRecordInput({ ...valid, segment: "" })).toEqual({
      ok: false, error: "segment_required",
    });
  });

  it("rejects out-of-range engagement and non-positive sample", () => {
    expect(validateRecordInput({ ...valid, engagement: 1.2 })).toEqual({
      ok: false, error: "engagement_out_of_range",
    });
    expect(validateRecordInput({ ...valid, engagement: NaN })).toEqual({
      ok: false, error: "engagement_out_of_range",
    });
    expect(validateRecordInput({ ...valid, sample: 0 })).toEqual({
      ok: false, error: "sample_must_be_positive",
    });
    expect(validateRecordInput({ ...valid, sample: -3 })).toEqual({
      ok: false, error: "sample_must_be_positive",
    });
  });
});

describe("recordReaction — running mean", () => {
  it("creates an entry then updates the sample-weighted mean in place", async () => {
    const store = new InMemoryDnaStore();
    const first = await recordReaction(store, {
      tenantId: TENANT, messageVariant: "v1", segment: "smb", engagement: 1,
    });
    expect(first).not.toBeNull();
    expect(first!.engagement).toBe(1);
    expect(first!.sampleSize).toBe(1);

    const second = await recordReaction(store, {
      tenantId: TENANT, messageVariant: "v1", segment: "smb", engagement: 0,
    });
    // (1×1 + 0×1) / 2 = 0.5
    expect(second!.engagement).toBeCloseTo(0.5, 10);
    expect(second!.sampleSize).toBe(2);

    expect(await store.count(TENANT, "customer_reaction")).toBe(1); // upsert
  });

  it("weights batch samples", async () => {
    const store = new InMemoryDnaStore();
    await recordReaction(store, {
      tenantId: TENANT, messageVariant: "v1", segment: "smb", engagement: 1, sample: 3,
    });
    const after = await recordReaction(store, {
      tenantId: TENANT, messageVariant: "v1", segment: "smb", engagement: 0, sample: 1,
    });
    // (1×3 + 0×1) / 4 = 0.75
    expect(after!.engagement).toBeCloseTo(0.75, 10);
    expect(after!.sampleSize).toBe(4);
  });

  it("confidence rises with sample size", async () => {
    const store = new InMemoryDnaStore();
    await recordReaction(store, {
      tenantId: TENANT, messageVariant: "v1", segment: "smb", engagement: 0.5,
    });
    const row1 = await store.get(TENANT, "customer_reaction", reactionKey("v1", "smb"));
    await recordReaction(store, {
      tenantId: TENANT, messageVariant: "v1", segment: "smb", engagement: 0.5, sample: 20,
    });
    const row2 = await store.get(TENANT, "customer_reaction", reactionKey("v1", "smb"));
    expect(row2!.confidence).toBeGreaterThan(row1!.confidence);
    expect(row2!.confidence).toBeLessThanOrEqual(1);
  });
});

describe("getReactionMatrix", () => {
  it("filters by segment / variant", async () => {
    const store = new InMemoryDnaStore();
    await recordReaction(store, { tenantId: TENANT, messageVariant: "v1", segment: "smb", engagement: 0.9 });
    await recordReaction(store, { tenantId: TENANT, messageVariant: "v2", segment: "smb", engagement: 0.4 });
    await recordReaction(store, { tenantId: TENANT, messageVariant: "v1", segment: "ent", engagement: 0.7 });

    expect((await getReactionMatrix(store, { tenantId: TENANT })).length).toBe(3);
    expect((await getReactionMatrix(store, { tenantId: TENANT, segment: "smb" })).length).toBe(2);
    expect(
      (await getReactionMatrix(store, { tenantId: TENANT, messageVariant: "v1" })).length,
    ).toBe(2);
    expect((await getReactionMatrix(store, { tenantId: "other" })).length).toBe(0);
  });
});

describe("recommendBestMessage", () => {
  it("explains when nothing has been recorded", async () => {
    const store = new InMemoryDnaStore();
    const out = await recommendBestMessage(store, { tenantId: TENANT, segment: "smb" });
    expect(out.entry).toBeNull();
    expect(out.reason).toContain("no reactions recorded");
  });

  it("suppresses the winner below the sample-size floor", async () => {
    const store = new InMemoryDnaStore();
    await recordReaction(store, {
      tenantId: TENANT, messageVariant: "v1", segment: "smb", engagement: 0.9,
    }); // sampleSize=1 < 3
    const out = await recommendBestMessage(store, { tenantId: TENANT, segment: "smb" });
    expect(out.entry).toBeNull();
    expect(out.reason).toContain("suppressed");
    expect(out.candidates.length).toBe(1);
  });

  it("picks the engagement winner meeting the floor and sorts candidates", async () => {
    const store = new InMemoryDnaStore();
    await recordReaction(store, {
      tenantId: TENANT, messageVariant: "v-low", segment: "smb", engagement: 0.3, sample: 5,
    });
    await recordReaction(store, {
      tenantId: TENANT, messageVariant: "v-high", segment: "smb", engagement: 0.8, sample: 5,
    });
    const out = await recommendBestMessage(store, { tenantId: TENANT, segment: "smb" });
    expect(out.entry?.messageVariant).toBe("v-high");
    expect(out.candidates[0]?.messageVariant).toBe("v-high");
    expect(out.reason).toContain("top engagement");
  });

  it("restricts to candidateVariants when provided", async () => {
    const store = new InMemoryDnaStore();
    await recordReaction(store, {
      tenantId: TENANT, messageVariant: "v-high", segment: "smb", engagement: 0.9, sample: 5,
    });
    await recordReaction(store, {
      tenantId: TENANT, messageVariant: "v-mid", segment: "smb", engagement: 0.5, sample: 5,
    });
    const out = await recommendBestMessage(store, {
      tenantId: TENANT,
      segment: "smb",
      candidateVariants: ["v-mid"],
    });
    expect(out.entry?.messageVariant).toBe("v-mid");

    const none = await recommendBestMessage(store, {
      tenantId: TENANT,
      segment: "smb",
      candidateVariants: ["missing"],
    });
    expect(none.entry).toBeNull();
    expect(none.reason).toContain("no candidate variants");
  });
});
