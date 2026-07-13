/**
 * Ported from dev-dashboard-v2 `tests/marketplace.test.ts` and
 * `tests/marketplace/reviews.test.ts` (lib-level scenarios; HTTP route tests
 * stay in the app) — adapted from supabase mocks to InMemoryMarketplaceStore.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { scrubText, extractAnonymizedPattern, extractSuccessSignals } from "./anonymize";
import { MarketplaceService, InMemoryMarketplaceStore } from "./marketplace";
import type { TemplateRow } from "./types";

let store: InMemoryMarketplaceStore;
let service: MarketplaceService;

beforeEach(() => {
  store = new InMemoryMarketplaceStore();
  service = new MarketplaceService({ store });
});

function seedTemplate(overrides: Partial<TemplateRow> = {}): TemplateRow {
  const row: TemplateRow = {
    id: `tpl-${store.templates.length + 1}`,
    tenant_id: "t",
    submitted_by: null,
    title: "T",
    description: null,
    industry: null,
    campaign_type: "email",
    goal: null,
    anonymized_pattern: {},
    success_signals: {},
    tags: null,
    status: "published",
    published: true,
    clone_count: 0,
    review_count: 0,
    avg_rating: null,
    pattern_hash: null,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
  store.templates.push(row);
  return row;
}

// ─── 1) Anonymization unit tests ────────────────────────────────────────────

describe("scrubText (anonymization primitives)", () => {
  it("strips company suffixes (Inc/Corp/株式会社)", () => {
    expect(scrubText("Acme Inc. launched")).not.toContain("Acme");
    expect(scrubText("株式会社サンプル の事例")).not.toMatch(/サンプル/);
  });

  it("strips absolute KPI numbers (件/円/%)", () => {
    expect(scrubText("CTR 12.5% improved")).not.toMatch(/12\.5%/);
    expect(scrubText("売上 1,200,000円 達成")).not.toMatch(/1,200,000/);
  });

  it("fully strips single-digit and CJK-unit absolute numbers (regression: trailing \\b leak)", () => {
    // Before the fix ABSOLUTE_NUMBER_RE matched nothing for CJK/% units, so
    // these absolute values (and the surviving unit) leaked into the pattern.
    expect(scrubText("CTRが8%改善")).not.toMatch(/8\s*%/);
    expect(scrubText("成長は3倍でした")).not.toMatch(/3\s*倍/);
    expect(scrubText("問い合わせが3件")).not.toMatch(/3\s*件/);
    expect(scrubText("価格は5,000円")).not.toMatch(/\d/); // no digit survives
    expect(scrubText("参加者10名")).not.toMatch(/10\s*名/);
    // CTR 12.5% must lose the trailing "5%" too, not just the "12"
    expect(scrubText("CTR 12.5% improved")).not.toMatch(/5\s*%/);
    // structural relative tokens are still preserved
    expect(scrubText("launch+30d")).toBe("launch+{n}d");
  });

  it("strips emails and urls", () => {
    const out = scrubText("contact ceo@acme.io https://acme.io/case");
    expect(out).toContain("{email}");
    expect(out).toContain("{url}");
    expect(out).not.toContain("acme.io");
  });

  it("returns empty string for empty input", () => {
    expect(scrubText("")).toBe("");
  });
});

describe("extractAnonymizedPattern", () => {
  it("preserves construction shape and scrubs strings", () => {
    const pattern = extractAnonymizedPattern({
      subject: "Acme Inc. の売上を 200% 改善する方法",
      channels: ["Email", "RETARGETING"],
      timing: ["launch+30d", "launch+10000d"],
      components: ["CTA", "social_proof: 1500件 reviews"],
      tone: "urgent",
      extras: { headlineCount: 3, abVariants: ["A", "B"], deep: { nested: { inner: "Acme Inc. internal" } } },
    });
    expect(pattern.subjectPattern).not.toContain("Acme");
    expect(pattern.subjectPattern).not.toContain("200");
    expect(pattern.channels).toEqual(["email", "retargeting"]);
    expect(pattern.timing?.[0]).toBe("launch+{n}d");
    expect(pattern.components?.[1]).not.toContain("1500");
    expect(pattern.tone).toBe("urgent");
    expect(pattern.extras?.headlineCount).toBe("{n}");
    expect(pattern.extras?.abVariants).toEqual(["A", "B"]);
  });

  it("accepts subjectPattern alias and ignores invalid types", () => {
    const p = extractAnonymizedPattern({
      subjectPattern: "Buy {benefit} today",
      channels: [123, "email"], // mixed types
      tone: 999, // not a string → dropped
    });
    expect(p.subjectPattern).toContain("Buy");
    expect(p.channels).toEqual(["email"]);
    expect(p.tone).toBeUndefined();
  });

  it("handles empty input", () => {
    expect(extractAnonymizedPattern({})).toEqual({});
  });

  it("clamps recursion depth via scrubObject", () => {
    const deep: Record<string, unknown> = { a: { b: { c: { d: { e: "Acme Inc. nested" } } } } };
    const p = extractAnonymizedPattern({ extras: deep });
    // 4 levels deep → inner becomes {} per depth>3 guard
    expect(p.extras).toBeDefined();
  });
});

describe("extractSuccessSignals", () => {
  it("scrubs string fields and rounds durabilityDays", () => {
    const s = extractSuccessSignals({
      ctrLift: "≥1.5x baseline at Acme Inc.",
      cvrRange: "high",
      engagementShape: "spike then plateau",
      durabilityDays: 14.7,
      notes: "secret 50000 円 saved",
    });
    expect(s.ctrLift).not.toContain("Acme");
    expect(s.cvrRange).toBe("high");
    expect(s.engagementShape).toBe("spike then plateau");
    expect(s.durabilityDays).toBe(15);
    expect(s.notes).not.toContain("50000");
  });

  it("ignores zero/negative durabilityDays", () => {
    const s = extractSuccessSignals({ durabilityDays: 0 });
    expect(s.durabilityDays).toBeUndefined();
  });
});

// ─── 2) Service tests ───────────────────────────────────────────────────────

describe("submitTemplate", () => {
  it("rejects missing tenantId", async () => {
    await expect(
      service.submitTemplate("", null, { title: "x", campaignType: "email", rawSource: {} }),
    ).rejects.toThrow("tenant_required");
  });

  it("rejects empty title and missing campaignType", async () => {
    await expect(
      service.submitTemplate("t", null, { title: "  ", campaignType: "email", rawSource: {} }),
    ).rejects.toThrow("title_required");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      service.submitTemplate("t", null, { title: "ok", campaignType: undefined as any, rawSource: {} }),
    ).rejects.toThrow("campaign_type_required");
  });

  it("anonymizes input and persists draft when publish=false", async () => {
    const out = await service.submitTemplate("t", "u1", {
      title: "Acme Inc. winning email",
      campaignType: "email",
      rawSource: { subject: "Acme Inc. boosted 200%" },
    });
    expect(out?.status).toBe("draft");
    expect(out?.published).toBe(false);
    expect(out?.title).not.toContain("Acme");
    expect(store.templates[0]!.anonymized_pattern.subjectPattern).not.toContain("Acme");
    expect(store.templates[0]!.anonymized_pattern.subjectPattern).not.toContain("200");
  });

  it("returns null when insert fails", async () => {
    class FailingStore extends InMemoryMarketplaceStore {
      override async insertTemplateReturning(): Promise<TemplateRow | null> {
        return null;
      }
    }
    const failing = new MarketplaceService({ store: new FailingStore() });
    const out = await failing.submitTemplate("t", null, { title: "x", campaignType: "ad", rawSource: {} });
    expect(out).toBeNull();
  });

  it("publishes immediately when publish=true", async () => {
    const out = await service.submitTemplate("t", null, {
      title: "ok", campaignType: "lp", goal: "lead_gen", industry: "saas",
      tags: ["foo"], description: "Acme description",
      rawSource: { components: ["hero", "cta"] },
      publish: true,
    });
    expect(out?.published).toBe(true);
    expect(out?.status).toBe("published");
    expect(out?.tags).toEqual(["foo"]);
  });
});

describe("listMarketplace", () => {
  it("returns mapped published rows only", async () => {
    seedTemplate({ id: "id3", anonymized_pattern: { tone: "x" }, clone_count: 7, review_count: 3, avg_rating: "4.5" });
    seedTemplate({ id: "id-draft", published: false, status: "draft" });

    const out = await service.listMarketplace();
    expect(out).toHaveLength(1);
    expect(out[0]!.avgRating).toBe(4.5);
    expect(out[0]!.cloneCount).toBe(7);
  });

  it("overlays vw_template_ratings values onto marketplace list rows", async () => {
    seedTemplate({ id: "id-rating" });
    store.ratings.push({
      template_id: "id-rating",
      avg_rating: "4.75",
      review_count: 8,
      clone_count: 13,
    });

    const out = await service.listMarketplace();
    expect(out[0]).toMatchObject({
      id: "id-rating",
      avgRating: 4.75,
      reviewCount: 8,
      cloneCount: 13,
    });
  });

  it("applies filter parameters and clamps limit", async () => {
    seedTemplate({ id: "a", industry: "saas", campaign_type: "ad", goal: "cvr", title: "The WinBack Deal" });
    seedTemplate({ id: "b", industry: "retail", campaign_type: "ad", goal: "cvr", title: "other" });

    const out = await service.listMarketplace({
      industry: "saas",
      campaignType: "ad",
      goal: "cvr",
      // %/* は service 側で除去される（元実装の ilike エスケープと同挙動）
      search: "win%back",
      limit: 9999, // clamped to 200 internally
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("a");
  });

  it("clamps the limit to 200 and floors at 1", async () => {
    class SpyStore extends InMemoryMarketplaceStore {
      lastLimit = 0;
      override async listPublishedTemplates(filters: { limit: number } & Record<string, unknown>) {
        this.lastLimit = filters.limit;
        return [];
      }
    }
    const spy = new SpyStore();
    const svc = new MarketplaceService({ store: spy });
    await svc.listMarketplace({ limit: 9999 });
    expect(spy.lastLimit).toBe(200);
    await svc.listMarketplace({ limit: 0 });
    expect(spy.lastLimit).toBe(1);
  });

  it("returns [] when store returns null", async () => {
    class NullStore extends InMemoryMarketplaceStore {
      override async listPublishedTemplates(): Promise<TemplateRow[] | null> {
        return null;
      }
    }
    const svc = new MarketplaceService({ store: new NullStore() });
    expect(await svc.listMarketplace()).toEqual([]);
  });

  it("falls back to cached row ratings when the ratings view is unavailable", async () => {
    class ThrowingRatings extends InMemoryMarketplaceStore {
      override async getTemplateRatings(): Promise<never> {
        throw new Error("view_missing");
      }
    }
    const throwing = new ThrowingRatings();
    const svc = new MarketplaceService({ store: throwing });
    throwing.templates.push(seedTemplateInto(throwing, { id: "id-cache", clone_count: 2, review_count: 1, avg_rating: "5" }));

    const out = await svc.listMarketplace();
    expect(out[0]!.avgRating).toBe(5);
    expect(out[0]!.reviewCount).toBe(1);
    expect(out[0]!.cloneCount).toBe(2);
  });
});

function seedTemplateInto(target: InMemoryMarketplaceStore, overrides: Partial<TemplateRow>): TemplateRow {
  return {
    id: "x", tenant_id: "t", submitted_by: null, title: "T", description: null,
    industry: null, campaign_type: "email", goal: null,
    anonymized_pattern: {}, success_signals: {},
    tags: null, status: "published", published: true,
    clone_count: 0, review_count: 0, avg_rating: null, pattern_hash: null,
    created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("cloneTemplate", () => {
  it("rejects missing inputs", async () => {
    await expect(service.cloneTemplate("", null, { templateId: "x" })).rejects.toThrow("tenant_required");
    await expect(service.cloneTemplate("t", null, { templateId: "" })).rejects.toThrow("template_required");
  });

  it("throws when template missing or not published", async () => {
    await expect(service.cloneTemplate("t", null, { templateId: "missing" })).rejects.toThrow("template_not_found");

    seedTemplate({ id: "x", published: false, status: "draft" });
    await expect(service.cloneTemplate("t", null, { templateId: "x" })).rejects.toThrow("template_not_published");
  });

  it("inserts clone and increments cache when template is published", async () => {
    seedTemplate({ id: "x", clone_count: 4 });

    const out = await service.cloneTemplate("t", "u1", { templateId: "x", customizations: { foo: "bar" } });
    expect(out?.customizations).toEqual({ foo: "bar" });
    expect(out?.status).toBe("cloned");
    expect(store.clones).toHaveLength(1);
    expect(store.templates[0]!.clone_count).toBe(5);
  });

  it("returns null when clone insert fails", async () => {
    class FailingClone extends InMemoryMarketplaceStore {
      override async insertCloneReturning(): Promise<null> {
        return null;
      }
    }
    const failing = new FailingClone();
    failing.templates.push(seedTemplateInto(failing, { id: "x" }));
    const svc = new MarketplaceService({ store: failing });
    const out = await svc.cloneTemplate("t", null, { templateId: "x" });
    expect(out).toBeNull();
  });
});

describe("addReview", () => {
  it("rejects rating out of range / non-integer", async () => {
    await expect(service.addReview("t", null, { templateId: "x", rating: 0 })).rejects.toThrow("rating_out_of_range");
    await expect(service.addReview("t", null, { templateId: "x", rating: 6 })).rejects.toThrow("rating_out_of_range");
    await expect(service.addReview("t", null, { templateId: "x", rating: 3.5 })).rejects.toThrow("rating_out_of_range");
  });

  it("rejects missing tenant or template", async () => {
    await expect(service.addReview("", null, { templateId: "x", rating: 3 })).rejects.toThrow("tenant_required");
    await expect(service.addReview("t", null, { templateId: "", rating: 3 })).rejects.toThrow("template_required");
  });

  it("scrubs comment and persists review", async () => {
    const out = await service.addReview("t", null, {
      templateId: "x", rating: 5, comment: "Acme Inc. saved 50%!",
      outcomeSummary: { used: true },
    });
    expect(out?.rating).toBe(5);
    expect(store.reviews[0]!.comment).not.toContain("Acme");
    expect(store.reviews[0]!.comment).not.toContain("50%");
  });
});

describe("listReviewsForTemplate / getReviewSummaryForTemplate", () => {
  it("returns [] / empty summary for empty templateId", async () => {
    expect(await service.listReviewsForTemplate("")).toEqual([]);
    const summary = await service.getReviewSummaryForTemplate("");
    expect(summary.count).toBe(0);
    expect(summary.average).toBe(0);
  });

  it("lists reviews newest-first with limit/offset", async () => {
    for (let i = 1; i <= 3; i++) {
      store.reviews.push({
        id: `r${i}`, template_id: "tplA", tenant_id: "t", reviewer_user_id: null,
        rating: i, comment: null, outcome_summary: {},
        created_at: `2026-05-0${i}T00:00:00.000Z`,
      });
    }
    const page = await service.listReviewsForTemplate("tplA", { limit: 2, offset: 1 });
    expect(page.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("computes count, average and 1..5 histogram", async () => {
    const ratings = [5, 5, 4, 3, 1];
    ratings.forEach((rating, i) => {
      store.reviews.push({
        id: `r${i}`, template_id: "tplB", tenant_id: "t", reviewer_user_id: null,
        rating, comment: null, outcome_summary: {}, created_at: "2026-05-01T00:00:00.000Z",
      });
    });
    const summary = await service.getReviewSummaryForTemplate("tplB");
    expect(summary.count).toBe(5);
    expect(summary.average).toBe(3.6);
    expect(summary.distribution).toEqual({ 1: 1, 2: 0, 3: 1, 4: 1, 5: 2 });
  });
});

describe("listOwnTemplates / getTemplateById", () => {
  it("returns [] for empty tenantId", async () => {
    expect(await service.listOwnTemplates("")).toEqual([]);
  });

  it("queries by tenant_id and maps rows (drafts included)", async () => {
    seedTemplate({ id: "id4", tenant_id: "t", submitted_by: "u", campaign_type: "ad", published: false, status: "draft" });
    seedTemplate({ id: "other", tenant_id: "someone-else" });
    const out = await service.listOwnTemplates("t");
    expect(out).toHaveLength(1);
    expect(out[0]!.submittedBy).toBe("u");
  });

  it("getTemplateById returns null for blank id and maps found rows", async () => {
    expect(await service.getTemplateById("")).toBeNull();
    seedTemplate({ id: "id5" });
    const tpl = await service.getTemplateById("id5");
    expect(tpl?.id).toBe("id5");
  });
});
