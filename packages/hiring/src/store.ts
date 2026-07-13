/**
 * Persistence interface for the hiring service.
 *
 * The original 実運用SaaS routes call Supabase REST directly
 * (supabaseGet / supabaseInsert / supabasePatch / supabaseDelete against
 * dd_job_postings / dd_applications / dd_application_events / dd_landing_pages /
 * dashboard_team_members). Those calls are collapsed into this typed store so
 * any backend (Supabase, Postgres, etc.) can be injected.
 */
import type {
  AdminApplication,
  Application,
  ApplicationEventType,
  JobPosting,
  LandingPageRow,
} from "./types";

export interface HiringStore {
  // ─ job postings ─
  listJobPostings(tenantId: string): Promise<JobPosting[]>;
  getJobPosting(tenantId: string, id: string): Promise<JobPosting | null>;
  /** Insert a fully-formed posting row. */
  insertJobPosting(row: JobPosting): Promise<void>;
  patchJobPosting(tenantId: string, id: string, patch: Partial<JobPosting>): Promise<boolean>;
  deleteJobPosting(tenantId: string, id: string): Promise<boolean>;

  // ─ applications ─
  /** Admin list — excludes gdpr_deletion_token / ip_address. */
  listApplications(tenantId: string, postingId: string): Promise<AdminApplication[]>;
  insertApplication(row: Application): Promise<void>;
  patchApplication(tenantId: string, id: string, patch: Partial<Application>): Promise<boolean>;
  /** Look up an application by its GDPR deletion token. */
  findApplicationByToken(token: string): Promise<{ id: string; tenant_id: string } | null>;
  deleteApplication(id: string): Promise<boolean>;

  // ─ public career flow ─
  /** Published + category=recruit landing page by slug. */
  getPublishedRecruitPage(slug: string): Promise<LandingPageRow | null>;
  getPostingForTenant(tenantId: string, postingId: string): Promise<JobPosting | null>;
  listAdminEmails(tenantId: string): Promise<string[]>;

  // ─ audit trail ─
  insertEvent(
    applicationId: string,
    eventType: ApplicationEventType,
    payload: Record<string, unknown>,
  ): Promise<void>;
}

// ─── In-memory implementation (tests / local dev) ─────────────────────────────

interface StoredEvent {
  application_id: string;
  event_type: ApplicationEventType;
  payload: Record<string, unknown>;
}

export class InMemoryHiringStore implements HiringStore {
  postings = new Map<string, JobPosting>();
  applications = new Map<string, Application>();
  pages = new Map<string, LandingPageRow>();
  adminEmails = new Map<string, string[]>();
  events: StoredEvent[] = [];

  async listJobPostings(tenantId: string): Promise<JobPosting[]> {
    return [...this.postings.values()]
      .filter((p) => p.tenant_id === tenantId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getJobPosting(tenantId: string, id: string): Promise<JobPosting | null> {
    const p = this.postings.get(id);
    return p && p.tenant_id === tenantId ? p : null;
  }

  async insertJobPosting(row: JobPosting): Promise<void> {
    this.postings.set(row.id, row);
  }

  async patchJobPosting(tenantId: string, id: string, patch: Partial<JobPosting>): Promise<boolean> {
    const p = this.postings.get(id);
    if (!p || p.tenant_id !== tenantId) return false;
    this.postings.set(id, { ...p, ...patch, updated_at: new Date().toISOString() });
    return true;
  }

  async deleteJobPosting(tenantId: string, id: string): Promise<boolean> {
    const p = this.postings.get(id);
    if (!p || p.tenant_id !== tenantId) return false;
    return this.postings.delete(id);
  }

  async listApplications(tenantId: string, postingId: string): Promise<AdminApplication[]> {
    return [...this.applications.values()]
      .filter((a) => a.tenant_id === tenantId && a.job_posting_id === postingId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(({ gdpr_deletion_token: _t, ip_address: _i, ...rest }) => rest);
  }

  async insertApplication(row: Application): Promise<void> {
    this.applications.set(row.id, row);
  }

  async patchApplication(tenantId: string, id: string, patch: Partial<Application>): Promise<boolean> {
    const a = this.applications.get(id);
    if (!a || a.tenant_id !== tenantId) return false;
    this.applications.set(id, { ...a, ...patch, updated_at: new Date().toISOString() });
    return true;
  }

  async findApplicationByToken(token: string): Promise<{ id: string; tenant_id: string } | null> {
    for (const a of this.applications.values()) {
      if (a.gdpr_deletion_token === token) return { id: a.id, tenant_id: a.tenant_id };
    }
    return null;
  }

  async deleteApplication(id: string): Promise<boolean> {
    return this.applications.delete(id);
  }

  async getPublishedRecruitPage(slug: string): Promise<LandingPageRow | null> {
    for (const p of this.pages.values()) {
      if (p.slug === slug && p.published && p.category === "recruit") return p;
    }
    return null;
  }

  async getPostingForTenant(tenantId: string, postingId: string): Promise<JobPosting | null> {
    const p = this.postings.get(postingId);
    return p && p.tenant_id === tenantId ? p : null;
  }

  async listAdminEmails(tenantId: string): Promise<string[]> {
    return this.adminEmails.get(tenantId) ?? [];
  }

  async insertEvent(
    applicationId: string,
    eventType: ApplicationEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.events.push({ application_id: applicationId, event_type: eventType, payload });
  }
}
