/**
 * Template Marketplace service — submission / listing / cloning / reviews.
 *
 * Ported from 実運用SaaS `server/lib/template-marketplace.ts`.
 * Supabase calls (dd_marketplace_templates / dd_marketplace_reviews /
 * dd_marketplace_clones / vw_template_ratings) are replaced with an injected
 * {@link MarketplaceStore}.
 */

import { scrubText, extractAnonymizedPattern, extractSuccessSignals } from "./anonymize";
import type {
  AddReviewInput,
  CloneRow,
  CloneTemplateInput,
  ListMarketplaceFilters,
  MarketplaceClone,
  MarketplaceReview,
  MarketplaceTemplate,
  ReviewRow,
  ReviewSummary,
  SubmitTemplateInput,
  TemplateRatingRow,
  TemplateRow,
} from "./types";

// ─── Store interface (mirrors the original query shapes) ─────────────────────

export interface MarketplaceStore {
  /** INSERT into dd_marketplace_templates with `Prefer: return=representation`. */
  insertTemplateReturning(row: Record<string, unknown>): Promise<TemplateRow | null>;
  /** `dd_marketplace_templates?id=eq.{id}&limit=1` (cross-tenant readable for published rows) */
  getTemplateById(templateId: string): Promise<TemplateRow | null>;
  /**
   * `dd_marketplace_templates?published=eq.true&order=created_at.desc[&industry=eq.…]
   *  [&campaign_type=eq.…][&goal=eq.…][&title=ilike.*…*]&limit={1..200}`
   */
  listPublishedTemplates(filters: {
    industry?: string;
    campaignType?: string;
    goal?: string;
    /** Case-insensitive substring match on title (ilike, %/* stripped by the service). */
    search?: string;
    limit: number;
  }): Promise<TemplateRow[] | null>;
  /** `vw_template_ratings?template_id=in.(…)` */
  getTemplateRatings(templateIds: string[]): Promise<TemplateRatingRow[] | null>;
  /** `dd_marketplace_templates?id=eq.{id}&select=id,published,clone_count` */
  getTemplatePublishState(
    templateId: string,
  ): Promise<{ id: string; published: boolean; clone_count: number } | null>;
  /** PATCH dd_marketplace_templates?id=eq.{id} */
  patchTemplate(templateId: string, patch: Record<string, unknown>): Promise<boolean>;
  /** INSERT into dd_marketplace_clones with returning */
  insertCloneReturning(row: Record<string, unknown>): Promise<CloneRow | null>;
  /** INSERT into dd_marketplace_reviews with returning */
  insertReviewReturning(row: Record<string, unknown>): Promise<ReviewRow | null>;
  /** `dd_marketplace_reviews?template_id=eq.{id}&order=created_at.desc&limit=…&offset=…` */
  listReviews(templateId: string, limit: number, offset: number): Promise<ReviewRow[] | null>;
  /** `dd_marketplace_reviews?template_id=eq.{id}&select=rating&limit=1000` */
  listReviewRatings(templateId: string, limit: number): Promise<Array<{ rating: number }> | null>;
  /** `dd_marketplace_templates?tenant_id=eq.{id}&order=created_at.desc&limit=100` */
  listTemplatesByTenant(tenantId: string, limit: number): Promise<TemplateRow[] | null>;
  /** `dd_marketplace_templates?tenant_id=eq.…&pattern_hash=eq.…` → id (extractor dedup) */
  findTemplateIdByPatternHash(tenantId: string, patternHash: string): Promise<string | null>;
}

// ─── Row mapping ────────────────────────────────────────────────────────────

export function mapTemplate(row: TemplateRow): MarketplaceTemplate {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    submittedBy: row.submitted_by,
    title: row.title,
    description: row.description,
    industry: row.industry,
    campaignType: (row.campaign_type as MarketplaceTemplate["campaignType"]) ?? "other",
    goal: (row.goal as MarketplaceTemplate["goal"]) ?? null,
    anonymizedPattern: row.anonymized_pattern ?? {},
    successSignals: row.success_signals ?? {},
    tags: row.tags ?? [],
    status: (row.status as MarketplaceTemplate["status"]) ?? "draft",
    published: !!row.published,
    cloneCount: row.clone_count ?? 0,
    reviewCount: row.review_count ?? 0,
    avgRating: row.avg_rating == null ? null : Number(row.avg_rating),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function applyRatingSummary(
  template: MarketplaceTemplate,
  rating: TemplateRatingRow | undefined,
): MarketplaceTemplate {
  if (!rating) return template;
  return {
    ...template,
    avgRating: rating.avg_rating == null ? null : Number(rating.avg_rating),
    reviewCount: Number(rating.review_count ?? template.reviewCount ?? 0),
    cloneCount: Number(rating.clone_count ?? template.cloneCount ?? 0),
  };
}

function mapReview(r: ReviewRow): MarketplaceReview {
  return {
    id: String(r.id),
    templateId: String(r.template_id),
    tenantId: String(r.tenant_id),
    reviewerUserId: r.reviewer_user_id == null ? null : String(r.reviewer_user_id),
    rating: Number(r.rating),
    comment: r.comment == null ? null : String(r.comment),
    outcomeSummary: (r.outcome_summary as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface MarketplaceServiceOptions {
  store: MarketplaceStore;
}

export class MarketplaceService {
  private readonly store: MarketplaceStore;

  constructor(options: MarketplaceServiceOptions) {
    this.store = options.store;
  }

  /** Submit a new template. 入力 raw を匿名化してから store に書く。 */
  async submitTemplate(
    tenantId: string,
    submittedBy: string | null,
    input: SubmitTemplateInput,
  ): Promise<MarketplaceTemplate | null> {
    if (!tenantId) throw new Error("tenant_required");
    if (!input.title?.trim()) throw new Error("title_required");
    if (!input.campaignType) throw new Error("campaign_type_required");

    const anonymized = extractAnonymizedPattern(input.rawSource ?? {});
    const signals = extractSuccessSignals(input.rawSource ?? {});
    const publish = !!input.publish;

    const row = await this.store.insertTemplateReturning({
      tenant_id: tenantId,
      submitted_by: submittedBy,
      title: scrubText(input.title),
      description: input.description ? scrubText(input.description) : null,
      industry: input.industry ?? null,
      campaign_type: input.campaignType,
      goal: input.goal ?? null,
      anonymized_pattern: anonymized,
      success_signals: signals,
      tags: input.tags ?? [],
      status: publish ? "published" : "draft",
      published: publish,
    });
    if (!row) return null;
    return mapTemplate(row);
  }

  /** Get a single template by ID. Cross-tenant readable for published rows. */
  async getTemplateById(templateId: string): Promise<MarketplaceTemplate | null> {
    if (!templateId) return null;
    const row = await this.store.getTemplateById(templateId);
    if (!row) return null;
    return mapTemplate(row);
  }

  /** List published templates with optional filters. */
  async listMarketplace(filters: ListMarketplaceFilters = {}): Promise<MarketplaceTemplate[]> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const rows = await this.store.listPublishedTemplates({
      industry: filters.industry,
      campaignType: filters.campaignType,
      goal: filters.goal,
      search: filters.search ? filters.search.replace(/[%*]/g, "") : undefined,
      limit,
    });
    const templates = (rows ?? []).map(mapTemplate);
    try {
      const ratings = await this.fetchTemplateRatings(templates.map((tpl) => tpl.id));
      return templates.map((tpl) => applyRatingSummary(tpl, ratings.get(tpl.id)));
    } catch {
      return templates;
    }
  }

  /** Clone a published template into the caller's tenant. */
  async cloneTemplate(
    tenantId: string,
    clonedBy: string | null,
    input: CloneTemplateInput,
  ): Promise<MarketplaceClone | null> {
    if (!tenantId) throw new Error("tenant_required");
    if (!input.templateId) throw new Error("template_required");

    // Verify the template exists and is published.
    const existing = await this.store.getTemplatePublishState(input.templateId);
    if (!existing) throw new Error("template_not_found");
    if (!existing.published) throw new Error("template_not_published");

    const r = await this.store.insertCloneReturning({
      template_id: input.templateId,
      tenant_id: tenantId,
      cloned_by: clonedBy,
      customizations: input.customizations ?? {},
      status: "cloned",
    });
    if (!r) return null;

    // Increment clone_count cache. Best-effort — failure does not block the clone.
    await this.store.patchTemplate(input.templateId, {
      clone_count: (existing.clone_count ?? 0) + 1,
    });

    return {
      id: String(r.id),
      templateId: String(r.template_id),
      tenantId: String(r.tenant_id),
      clonedBy: r.cloned_by == null ? null : String(r.cloned_by),
      customizations: (r.customizations as Record<string, unknown>) ?? {},
      status: (r.status as MarketplaceClone["status"]) ?? "cloned",
      createdAt: String(r.created_at),
    };
  }

  /** Add (upsert-equivalent) a review for a published template. */
  async addReview(
    tenantId: string,
    reviewerUserId: string | null,
    input: AddReviewInput,
  ): Promise<MarketplaceReview | null> {
    if (!tenantId) throw new Error("tenant_required");
    if (!input.templateId) throw new Error("template_required");
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new Error("rating_out_of_range");
    }

    const r = await this.store.insertReviewReturning({
      template_id: input.templateId,
      tenant_id: tenantId,
      reviewer_user_id: reviewerUserId,
      rating: input.rating,
      comment: input.comment ? scrubText(input.comment) : null,
      outcome_summary: input.outcomeSummary ?? {},
    });
    if (!r) return null;
    return mapReview(r);
  }

  /** List reviews for a template (cross-tenant readable for published rows). */
  async listReviewsForTemplate(
    templateId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<MarketplaceReview[]> {
    if (!templateId) return [];
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const offset = Math.max(0, options.offset ?? 0);
    const rows = await this.store.listReviews(templateId, limit, offset);
    return (rows ?? []).map(mapReview);
  }

  /** Aggregated summary for a template (count, average, histogram). */
  async getReviewSummaryForTemplate(templateId: string): Promise<ReviewSummary> {
    const empty: ReviewSummary = {
      templateId,
      count: 0,
      average: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    };
    if (!templateId) return empty;

    const rows = await this.store.listReviewRatings(templateId, 1000);
    if (!rows || rows.length === 0) return empty;

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as ReviewSummary["distribution"];
    let sum = 0;
    for (const r of rows) {
      const n = Number(r.rating);
      if (n >= 1 && n <= 5 && Number.isInteger(n)) {
        distribution[n as 1 | 2 | 3 | 4 | 5] += 1;
        sum += n;
      }
    }
    return {
      templateId,
      count: rows.length,
      average: Math.round((sum / rows.length) * 100) / 100,
      distribution,
    };
  }

  /** Drafts owned by the tenant (for "my submissions" view). */
  async listOwnTemplates(tenantId: string): Promise<MarketplaceTemplate[]> {
    if (!tenantId) return [];
    const rows = await this.store.listTemplatesByTenant(tenantId, 100);
    return (rows ?? []).map(mapTemplate);
  }

  private async fetchTemplateRatings(templateIds: string[]): Promise<Map<string, TemplateRatingRow>> {
    if (templateIds.length === 0) return new Map();
    const rows = await this.store.getTemplateRatings(templateIds);
    return new Map((rows ?? []).map((row) => [row.template_id, row]));
  }
}

// ─── In-memory implementation ────────────────────────────────────────────────

/** In-memory MarketplaceStore mirroring the PostgREST query semantics. */
export class InMemoryMarketplaceStore implements MarketplaceStore {
  templates: TemplateRow[] = [];
  reviews: ReviewRow[] = [];
  clones: CloneRow[] = [];
  /** Optional override rows for the vw_template_ratings view. */
  ratings: TemplateRatingRow[] = [];

  private readonly uuid: () => string;
  private readonly now: () => Date;

  constructor(options: { uuid?: () => string; now?: () => Date } = {}) {
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  async insertTemplateReturning(row: Record<string, unknown>): Promise<TemplateRow | null> {
    const nowIso = this.now().toISOString();
    const full: TemplateRow = {
      id: (row.id as string | undefined) ?? this.uuid(),
      tenant_id: String(row.tenant_id ?? ""),
      submitted_by: (row.submitted_by as string | null | undefined) ?? null,
      title: String(row.title ?? ""),
      description: (row.description as string | null | undefined) ?? null,
      industry: (row.industry as string | null | undefined) ?? null,
      campaign_type: String(row.campaign_type ?? "other"),
      goal: (row.goal as string | null | undefined) ?? null,
      anonymized_pattern: (row.anonymized_pattern as TemplateRow["anonymized_pattern"]) ?? {},
      success_signals: (row.success_signals as TemplateRow["success_signals"]) ?? {},
      tags: (row.tags as string[] | null | undefined) ?? [],
      status: String(row.status ?? "draft"),
      published: !!row.published,
      clone_count: Number(row.clone_count ?? 0),
      review_count: Number(row.review_count ?? 0),
      avg_rating: (row.avg_rating as number | string | null | undefined) ?? null,
      pattern_hash: (row.pattern_hash as string | null | undefined) ?? null,
      created_at: (row.created_at as string | undefined) ?? nowIso,
      updated_at: (row.updated_at as string | undefined) ?? nowIso,
    };
    this.templates.push(full);
    return full;
  }

  async getTemplateById(templateId: string): Promise<TemplateRow | null> {
    return this.templates.find((t) => t.id === templateId) ?? null;
  }

  async listPublishedTemplates(filters: {
    industry?: string;
    campaignType?: string;
    goal?: string;
    search?: string;
    limit: number;
  }): Promise<TemplateRow[] | null> {
    let rows = this.templates.filter((t) => t.published);
    if (filters.industry) rows = rows.filter((t) => t.industry === filters.industry);
    if (filters.campaignType) rows = rows.filter((t) => t.campaign_type === filters.campaignType);
    if (filters.goal) rows = rows.filter((t) => t.goal === filters.goal);
    if (filters.search) {
      const needle = filters.search.toLowerCase();
      rows = rows.filter((t) => t.title.toLowerCase().includes(needle));
    }
    return rows
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, filters.limit);
  }

  async getTemplateRatings(templateIds: string[]): Promise<TemplateRatingRow[] | null> {
    const set = new Set(templateIds);
    return this.ratings.filter((r) => set.has(r.template_id));
  }

  async getTemplatePublishState(
    templateId: string,
  ): Promise<{ id: string; published: boolean; clone_count: number } | null> {
    const t = this.templates.find((row) => row.id === templateId);
    if (!t) return null;
    return { id: t.id, published: t.published, clone_count: t.clone_count };
  }

  async patchTemplate(templateId: string, patch: Record<string, unknown>): Promise<boolean> {
    const t = this.templates.find((row) => row.id === templateId);
    if (!t) return false;
    Object.assign(t, patch);
    return true;
  }

  async insertCloneReturning(row: Record<string, unknown>): Promise<CloneRow | null> {
    const full: CloneRow = {
      id: (row.id as string | undefined) ?? this.uuid(),
      template_id: String(row.template_id ?? ""),
      tenant_id: String(row.tenant_id ?? ""),
      cloned_by: (row.cloned_by as string | null | undefined) ?? null,
      customizations: (row.customizations as Record<string, unknown> | null | undefined) ?? {},
      status: String(row.status ?? "cloned"),
      created_at: (row.created_at as string | undefined) ?? this.now().toISOString(),
    };
    this.clones.push(full);
    return full;
  }

  async insertReviewReturning(row: Record<string, unknown>): Promise<ReviewRow | null> {
    const full: ReviewRow = {
      id: (row.id as string | undefined) ?? this.uuid(),
      template_id: String(row.template_id ?? ""),
      tenant_id: String(row.tenant_id ?? ""),
      reviewer_user_id: (row.reviewer_user_id as string | null | undefined) ?? null,
      rating: Number(row.rating ?? 0),
      comment: (row.comment as string | null | undefined) ?? null,
      outcome_summary: (row.outcome_summary as Record<string, unknown> | null | undefined) ?? {},
      created_at: (row.created_at as string | undefined) ?? this.now().toISOString(),
    };
    this.reviews.push(full);
    return full;
  }

  async listReviews(templateId: string, limit: number, offset: number): Promise<ReviewRow[] | null> {
    return this.reviews
      .filter((r) => r.template_id === templateId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(offset, offset + limit);
  }

  async listReviewRatings(templateId: string, limit: number): Promise<Array<{ rating: number }> | null> {
    return this.reviews
      .filter((r) => r.template_id === templateId)
      .slice(0, limit)
      .map((r) => ({ rating: r.rating }));
  }

  async listTemplatesByTenant(tenantId: string, limit: number): Promise<TemplateRow[] | null> {
    return this.templates
      .filter((t) => t.tenant_id === tenantId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  async findTemplateIdByPatternHash(tenantId: string, patternHash: string): Promise<string | null> {
    return (
      this.templates.find((t) => t.tenant_id === tenantId && t.pattern_hash === patternHash)?.id ??
      null
    );
  }
}
