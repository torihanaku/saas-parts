/**
 * Lead scoring engine — deterministic scoring based on CRM and campaign data.
 *
 * Ported from dev-dashboard-v2 `server/lib/lead-scoring.ts`.
 * Calculates behavior, fit, and engagement scores for contacts, determines
 * MQL qualification, and persists results via an injected {@link LeadScoringStore}
 * (replacing the original dd_crm_contacts / dd_crm_deals / dd_marketing_campaigns /
 * dd_lead_scores Supabase queries). Weights and thresholds are injectable via
 * {@link ScoringConfig} with the original defaults.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LeadScore {
  contact_id: string;
  total_score: number;
  behavior_score: number;
  fit_score: number;
  engagement_score: number;
  dimensions: Record<string, number>;
  is_mql: boolean;
  scored_at: string;
}

export interface ScoringConfig {
  mql_threshold: number;
  weights: {
    email_open: number;
    email_click: number;
    site_visit: number;
    form_submit: number;
    deal_created: number;
    meeting_booked: number;
  };
}

export type ContactRecord = Record<string, unknown>;
export type DealRecord = Record<string, unknown>;
export type CampaignRecord = Record<string, unknown>;

// ─── Default config (source defaults) ────────────────────────────────────────

export function getDefaultScoringConfig(): ScoringConfig {
  return {
    mql_threshold: 50,
    weights: {
      email_open: 5,
      email_click: 10,
      site_visit: 3,
      form_submit: 20,
      deal_created: 30,
      meeting_booked: 25,
    },
  };
}

// ─── Store interface (mirrors the original query shapes) ─────────────────────

export interface LeadScoringStore {
  /** `dd_crm_contacts?id=eq.{id}&select=*&limit=1` */
  getContact(contactId: string): Promise<ContactRecord | null>;
  /** `dd_crm_contacts?project_id=eq.{id}&select=id` (bulk scoring input) */
  listContactIds(projectId: string): Promise<Array<{ id: string }> | null>;
  /** `dd_crm_deals?project_id=eq.{id}&select=*` */
  listDeals(projectId: string): Promise<DealRecord[] | null>;
  /** `dd_marketing_campaigns?project_id=eq.{id}&select=*` */
  listCampaigns(projectId: string): Promise<CampaignRecord[] | null>;
  /** `dd_lead_scores?contact_id=eq.{id}&select=id&limit=1` — returns existing row id */
  findLeadScoreId(contactId: string): Promise<string | null>;
  /** INSERT into dd_lead_scores */
  insertLeadScore(row: Record<string, unknown>): Promise<void>;
  /** PATCH dd_lead_scores?id=eq.{id} */
  patchLeadScore(id: string, row: Record<string, unknown>): Promise<void>;
  /** `dd_lead_scores?contact_id=eq.{id}&select=*&limit=1` (breakdown read path) */
  getLeadScoreByContact(contactId: string): Promise<Record<string, unknown> | null>;
}

// ─── Scoring helpers (pure) ──────────────────────────────────────────────────

export function calculateBehaviorScore(
  contact: ContactRecord,
  deals: DealRecord[],
  campaigns: CampaignRecord[],
  config: ScoringConfig,
): { score: number; dimensions: Record<string, number> } {
  const dimensions: Record<string, number> = {};
  let score = 0;

  // Email interactions from campaign metadata
  for (const campaign of campaigns) {
    const meta = (campaign.metadata as Record<string, unknown>) ?? {};
    const contactInteractions = (meta.contact_interactions as Record<string, unknown>) ?? {};
    const contactId = String(contact.id ?? "");

    if (contactInteractions[contactId]) {
      const interaction = contactInteractions[contactId] as Record<string, unknown>;
      if (interaction.opened) {
        const opens = Number(interaction.opens ?? 1);
        dimensions.email_open = opens * config.weights.email_open;
        score += dimensions.email_open;
      }
      if (interaction.clicked) {
        const clicks = Number(interaction.clicks ?? 1);
        dimensions.email_click = clicks * config.weights.email_click;
        score += dimensions.email_click;
      }
    }
  }

  // Deal activity
  const contactDeals = deals.filter(
    (d) => String(d.contact_id ?? "") === String(contact.id ?? ""),
  );
  if (contactDeals.length > 0) {
    dimensions.deal_created = contactDeals.length * config.weights.deal_created;
    score += dimensions.deal_created;
  }

  // Form submissions from contact metadata
  const meta = (contact.metadata as Record<string, unknown>) ?? {};
  const formSubmissions = Number(meta.form_submissions ?? 0);
  if (formSubmissions > 0) {
    dimensions.form_submit = formSubmissions * config.weights.form_submit;
    score += dimensions.form_submit;
  }

  // Site visits from contact metadata
  const siteVisits = Number(meta.site_visits ?? 0);
  if (siteVisits > 0) {
    dimensions.site_visit = siteVisits * config.weights.site_visit;
    score += dimensions.site_visit;
  }

  // Meeting booked from contact metadata
  const meetingsBooked = Number(meta.meetings_booked ?? 0);
  if (meetingsBooked > 0) {
    dimensions.meeting_booked = meetingsBooked * config.weights.meeting_booked;
    score += dimensions.meeting_booked;
  }

  return { score, dimensions };
}

export function calculateFitScore(contact: ContactRecord): number {
  let score = 0;
  const meta = (contact.metadata as Record<string, unknown>) ?? {};

  // Company size scoring
  const companySize = Number(meta.company_size ?? meta.employees ?? 0);
  if (companySize >= 1000) score += 20;
  else if (companySize >= 200) score += 15;
  else if (companySize >= 50) score += 10;
  else if (companySize > 0) score += 5;

  // Industry match scoring
  const industry = String(meta.industry ?? contact.company ?? "").toLowerCase();
  const highValueIndustries = ["technology", "saas", "software", "fintech", "healthcare"];
  if (highValueIndustries.some((i) => industry.includes(i))) score += 15;

  // Title scoring
  const title = String(contact.title ?? "").toLowerCase();
  if (title.includes("ceo") || title.includes("cto") || title.includes("vp") || title.includes("director")) {
    score += 15;
  } else if (title.includes("manager") || title.includes("head")) {
    score += 10;
  } else if (title.includes("lead") || title.includes("senior")) {
    score += 5;
  }

  return score;
}

export function calculateEngagementScore(contact: ContactRecord, nowMs: number = Date.now()): number {
  let score = 0;

  // Recency scoring — more recent activity = higher score
  const updatedAt = contact.updated_at as string | undefined;
  if (updatedAt) {
    const daysSinceUpdate = (nowMs - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUpdate <= 7) score += 20;
    else if (daysSinceUpdate <= 14) score += 15;
    else if (daysSinceUpdate <= 30) score += 10;
    else if (daysSinceUpdate <= 60) score += 5;
  }

  // Lifecycle stage scoring
  const stage = String(contact.lifecycle_stage ?? "").toLowerCase();
  if (stage === "opportunity") score += 15;
  else if (stage === "marketingqualifiedlead" || stage === "mql") score += 10;
  else if (stage === "salesqualifiedlead" || stage === "sql") score += 12;
  else if (stage === "lead") score += 5;

  return score;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface LeadScorerOptions {
  store: LeadScoringStore;
  /** Scoring weights / MQL threshold. Default: {@link getDefaultScoringConfig}. */
  config?: ScoringConfig;
  /** Clock injection for deterministic tests. Default: `() => new Date()`. */
  now?: () => Date;
  /** ID generator injection. Default: `crypto.randomUUID`. */
  uuid?: () => string;
}

const BATCH_SIZE = 50;

export class LeadScorer {
  private readonly store: LeadScoringStore;
  private readonly config: ScoringConfig;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(options: LeadScorerOptions) {
    this.store = options.store;
    this.config = options.config ?? getDefaultScoringConfig();
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
  }

  /**
   * Score a single contact. Fetches behavior data and computes composite score.
   */
  async scoreContact(contactId: string, projectId: string): Promise<LeadScore | null> {
    const config = this.config;

    const contact = await this.store.getContact(contactId);
    if (!contact) return null;

    // Fetch related data in parallel
    const [deals, campaigns] = await Promise.all([
      this.store.listDeals(projectId),
      this.store.listCampaigns(projectId),
    ]);

    const behavior = calculateBehaviorScore(contact, deals ?? [], campaigns ?? [], config);
    const fitScore = calculateFitScore(contact);
    const engagementScore = calculateEngagementScore(contact, this.now().getTime());

    const totalScore = behavior.score + fitScore + engagementScore;
    const score: LeadScore = {
      contact_id: contactId,
      total_score: totalScore,
      behavior_score: behavior.score,
      fit_score: fitScore,
      engagement_score: engagementScore,
      dimensions: {
        ...behavior.dimensions,
        fit: fitScore,
        engagement: engagementScore,
      },
      is_mql: totalScore >= config.mql_threshold,
      scored_at: this.now().toISOString(),
    };

    await this.upsertLeadScore(contactId, projectId, score);
    return score;
  }

  /**
   * Score all contacts for a project in batches.
   */
  async bulkScoreContacts(projectId: string): Promise<{ scored: number; mqls: number }> {
    const contacts = await this.store.listContactIds(projectId);
    if (!contacts || contacts.length === 0) return { scored: 0, mqls: 0 };

    let scored = 0;
    let mqls = 0;
    const contactIds = contacts.map((c) => String(c.id ?? ""));

    for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
      const batch = contactIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((id) => this.scoreContact(id, projectId)),
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          scored++;
          if (r.value.is_mql) mqls++;
        }
      }
    }

    return { scored, mqls };
  }

  /**
   * Get the score breakdown for a specific contact.
   */
  async getScoreBreakdown(contactId: string): Promise<LeadScore | null> {
    const row = await this.store.getLeadScoreByContact(contactId);
    if (!row) return null;

    return {
      contact_id: String(row.contact_id),
      total_score: Number(row.total_score ?? 0),
      behavior_score: Number(row.behavior_score ?? 0),
      fit_score: Number(row.fit_score ?? 0),
      engagement_score: Number(row.engagement_score ?? 0),
      dimensions: (row.dimensions as Record<string, number>) ?? {},
      is_mql: Boolean(row.is_mql),
      scored_at: String(row.scored_at ?? ""),
    };
  }

  // ─── Score upsert helper ────────────────────────────────────────────────────

  private async upsertLeadScore(contactId: string, projectId: string, score: LeadScore): Promise<void> {
    const existingId = await this.store.findLeadScoreId(contactId);

    const data = {
      contact_id: contactId,
      project_id: projectId,
      total_score: score.total_score,
      behavior_score: score.behavior_score,
      fit_score: score.fit_score,
      engagement_score: score.engagement_score,
      dimensions: score.dimensions,
      is_mql: score.is_mql,
      scored_at: score.scored_at,
      updated_at: this.now().toISOString(),
    };

    if (existingId) {
      await this.store.patchLeadScore(existingId, data);
    } else {
      await this.store.insertLeadScore({ id: this.uuid(), ...data });
    }
  }
}

// ─── In-memory implementation ────────────────────────────────────────────────

/** In-memory LeadScoringStore mirroring the PostgREST query semantics. */
export class InMemoryLeadScoringStore implements LeadScoringStore {
  contacts: Array<ContactRecord & { id: string; project_id?: string }> = [];
  deals: Array<DealRecord & { project_id?: string }> = [];
  campaigns: Array<CampaignRecord & { project_id?: string }> = [];
  leadScores: Array<Record<string, unknown> & { id: string; contact_id: string }> = [];

  async getContact(contactId: string): Promise<ContactRecord | null> {
    return this.contacts.find((c) => c.id === contactId) ?? null;
  }

  async listContactIds(projectId: string): Promise<Array<{ id: string }> | null> {
    return this.contacts
      .filter((c) => c.project_id === undefined || c.project_id === projectId)
      .map((c) => ({ id: c.id }));
  }

  async listDeals(projectId: string): Promise<DealRecord[] | null> {
    return this.deals.filter((d) => d.project_id === undefined || d.project_id === projectId);
  }

  async listCampaigns(projectId: string): Promise<CampaignRecord[] | null> {
    return this.campaigns.filter((c) => c.project_id === undefined || c.project_id === projectId);
  }

  async findLeadScoreId(contactId: string): Promise<string | null> {
    return this.leadScores.find((s) => s.contact_id === contactId)?.id ?? null;
  }

  async insertLeadScore(row: Record<string, unknown>): Promise<void> {
    this.leadScores.push({ ...row } as Record<string, unknown> & { id: string; contact_id: string });
  }

  async patchLeadScore(id: string, row: Record<string, unknown>): Promise<void> {
    const existing = this.leadScores.find((s) => s.id === id);
    if (existing) Object.assign(existing, row);
  }

  async getLeadScoreByContact(contactId: string): Promise<Record<string, unknown> | null> {
    return this.leadScores.find((s) => s.contact_id === contactId) ?? null;
  }
}
