/**
 * Ported from 実運用SaaS `tests/marketplace/extractor.test.ts` —
 * adapted from claude-api-client / supabase-admin mocks to the injected
 * JsonGenerator callback and InMemoryMarketplaceStore.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  extractPatterns,
  persistPatterns,
  selectTopDecile,
  patternHash,
  type CampaignSnapshot,
  type ExtractedPattern,
  type JsonGenerator,
} from "./extractor";
import { InMemoryMarketplaceStore } from "./marketplace";

const TENANT = "tenant-mp";

function makeCampaigns(n: number): CampaignSnapshot[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    name: `Acme Inc. promo ${i}`,
    campaignType: "email" as const,
    goal: "lead_gen" as const,
    industry: "saas",
    ctr: (i + 1) / 100,
    cvr: (i + 1) / 200,
  }));
}

function fakeGenerator(patterns: Array<Record<string, unknown>>): JsonGenerator {
  return async <T>(_system: string, _prompt: string, _fallback: T) =>
    ({ patterns }) as unknown as T;
}

describe("selectTopDecile", () => {
  it("returns max(1, ceil(n*0.1)) by combined CTR/CVR weight", () => {
    const campaigns = makeCampaigns(20);
    const top = selectTopDecile(campaigns);
    expect(top.length).toBe(2);
    expect(top[0]!.id).toBe("c19");
  });

  it("always returns at least one campaign even for tiny inputs", () => {
    const top = selectTopDecile(makeCampaigns(3));
    expect(top.length).toBe(1);
  });

  it("caps at maxTopDecile", () => {
    const top = selectTopDecile(makeCampaigns(100), { maxTopDecile: 5 });
    expect(top.length).toBe(5);
  });

  it("returns empty for empty input", () => {
    expect(selectTopDecile([])).toEqual([]);
  });
});

describe("patternHash", () => {
  it("is stable across calls", () => {
    const p = { subjectPattern: "{benefit}を{timeframe}で実現", channels: ["email", "ads"], tone: "calm" };
    expect(patternHash(p)).toBe(patternHash(p));
  });

  it("normalizes channel order so {email,ads} == {ads,email}", () => {
    expect(
      patternHash({ subjectPattern: "x", channels: ["email", "ads"], tone: "calm" }),
    ).toBe(
      patternHash({ subjectPattern: "x", channels: ["ads", "email"], tone: "calm" }),
    );
  });

  it("differs when subjectPattern differs", () => {
    expect(
      patternHash({ subjectPattern: "a", channels: [], tone: "" }),
    ).not.toBe(patternHash({ subjectPattern: "b", channels: [], tone: "" }));
  });
});

describe("extractPatterns", () => {
  it("returns [] when generateJson callback is not provided", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await extractPatterns(makeCampaigns(20), {});
    expect(out).toEqual([]);
    warn.mockRestore();
  });

  it("returns [] when the LLM returns the empty fallback (simulating API outage)", async () => {
    const out = await extractPatterns(makeCampaigns(20), { generateJson: fakeGenerator([]) });
    expect(out).toEqual([]);
  });

  it("extracts patterns from LLM output and scrubs leaked PII", async () => {
    const out = await extractPatterns(makeCampaigns(20), {
      generateJson: fakeGenerator([
        {
          subjectPattern: "Acme Inc. の {benefit}",
          channels: ["email", "ads"],
          tone: "urgent",
          components: ["primary_cta", "social_proof_count"],
        },
      ]),
    });

    expect(out).toHaveLength(1);
    // scrubText replaced "Acme Inc." with "{company}"
    expect(out[0]!.anonymized_pattern.subjectPattern).not.toContain("Acme");
    expect(out[0]!.anonymized_pattern.subjectPattern).toContain("{company}");
    expect(out[0]!.anonymized_pattern.channels).toEqual(["email", "ads"]);
    expect(out[0]!.pattern_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(out[0]!.source_campaign_count).toBe(2);
    expect(out[0]!.campaignType).toBe("email");
    expect(out[0]!.goal).toBe("lead_gen");
    expect(out[0]!.industry).toBe("saas");
  });

  it("scrubs campaign names before they reach the LLM prompt", async () => {
    let seenPrompt = "";
    const spy: JsonGenerator = async <T>(_s: string, prompt: string, fallback: T) => {
      seenPrompt = prompt;
      return fallback;
    };
    await extractPatterns(makeCampaigns(20), { generateJson: spy });
    expect(seenPrompt).not.toContain("Acme");
    expect(seenPrompt).toContain("ctr_bucket");
  });

  it("dedups identical pattern_hash within a single LLM response", async () => {
    const out = await extractPatterns(makeCampaigns(20), {
      generateJson: fakeGenerator([
        { subjectPattern: "{benefit}", channels: ["email"], tone: "calm" },
        { subjectPattern: "{benefit}", channels: ["email"], tone: "calm" },
        { subjectPattern: "{benefit}", channels: ["email"], tone: "calm" },
      ]),
    });
    expect(out).toHaveLength(1);
  });

  it("returns [] for empty campaign list", async () => {
    const out = await extractPatterns([], { generateJson: fakeGenerator([]) });
    expect(out).toEqual([]);
  });
});

describe("persistPatterns", () => {
  let store: InMemoryMarketplaceStore;

  const samplePattern: ExtractedPattern = {
    pattern_hash: "deadbeef".repeat(4),
    anonymized_pattern: { subjectPattern: "{x}", channels: ["email"], tone: "calm" },
    source_campaign_count: 5,
    campaignType: "email",
    goal: "lead_gen",
    industry: "saas",
  };

  beforeEach(() => {
    store = new InMemoryMarketplaceStore();
  });

  it("inserts when no existing row matches", async () => {
    const result = await persistPatterns(store, TENANT, [samplePattern]);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(store.templates).toHaveLength(1);
    const inserted = store.templates[0]!;
    expect(inserted.tenant_id).toBe(TENANT);
    expect(inserted.pattern_hash).toBe(samplePattern.pattern_hash);
    expect(inserted.status).toBe("draft");
    expect(inserted.published).toBe(false);
    expect(inserted.success_signals).toMatchObject({ source_campaign_count: 5, extracted_via: "claude-v1" });
  });

  it("updates when pattern_hash already exists for the tenant", async () => {
    await persistPatterns(store, TENANT, [samplePattern]);
    const result = await persistPatterns(store, TENANT, [
      { ...samplePattern, source_campaign_count: 9 },
    ]);
    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(0);
    expect(store.templates).toHaveLength(1);
    expect(store.templates[0]!.success_signals).toMatchObject({ source_campaign_count: 9 });
  });

  it("does not dedup across tenants", async () => {
    await persistPatterns(store, TENANT, [samplePattern]);
    const result = await persistPatterns(store, "other-tenant", [samplePattern]);
    expect(result.inserted).toBe(1);
    expect(store.templates).toHaveLength(2);
  });

  it("returns zeros for empty input without touching the store", async () => {
    const result = await persistPatterns(store, TENANT, []);
    expect(result).toEqual({ inserted: 0, updated: 0 });
    expect(store.templates).toHaveLength(0);
  });
});
