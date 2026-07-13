/**
 * Hiring service — job posting CRUD, applicant tracking (status transitions),
 * public career-page application submission, and applicant GDPR deletion.
 *
 * Ported from 実運用SaaS `server/routes/recruitment/`
 * (index / postings / applications / public / gdpr-delete-page / shared).
 *
 * Route-layer concerns removed (HTTP wiring, feature-flag gate, rate-limiter,
 * requireRole): those stay in the host app. The port here returns
 * {@link ServiceResult} objects so the caller maps them to any transport.
 * Email side-effects are exposed via an injected {@link HiringNotifier}.
 */
import type { HiringStore } from "./store";
import {
  EMAIL_RE,
  MAX_ANSWER_LEN,
  MAX_APPLICANT_EMAIL_LEN,
  MAX_APPLICANT_NAME_LEN,
  MAX_CUSTOM_QUESTIONS,
  isApplicationStatus,
  isValidUUID,
  validateJobPostingBody,
  type AdminApplication,
  type Application,
  type ApplicationAnswer,
  type CustomQuestion,
  type JobPosting,
} from "./types";

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

function fail(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}
function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

/** Optional email side-effects (RESEND in the original; fire-and-forget). */
export interface HiringNotifier {
  notifyAdmins(posting: JobPosting, application: Application, adminEmails: string[]): Promise<void> | void;
  notifyApplicant(posting: JobPosting, application: Application): Promise<void> | void;
}

export interface HiringServiceOptions {
  store: HiringStore;
  notifier?: HiringNotifier;
  /** ID generator (default crypto.randomUUID). */
  uuid?: () => string;
  /** Clock (default () => new Date()). */
  now?: () => Date;
  /** GDPR deletion token generator (default 32 url-safe bytes). */
  makeDeletionToken?: () => string;
  /** Retention window in ms for new applications (default 2 years). */
  retentionMs?: number;
}

const TWO_YEARS_MS = 1000 * 60 * 60 * 24 * 365 * 2;

function defaultToken(): string {
  // 24 random bytes → base64url, mirrors gen_random_bytes(24)/base64 in the SQL default.
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class HiringService {
  private store: HiringStore;
  private notifier?: HiringNotifier;
  private uuid: () => string;
  private now: () => Date;
  private makeDeletionToken: () => string;
  private retentionMs: number;

  constructor(opts: HiringServiceOptions) {
    this.store = opts.store;
    this.notifier = opts.notifier;
    this.uuid = opts.uuid ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => new Date());
    this.makeDeletionToken = opts.makeDeletionToken ?? defaultToken;
    this.retentionMs = opts.retentionMs ?? TWO_YEARS_MS;
  }

  // ─── Admin: job postings CRUD ───────────────────────────────────────────────

  async listJobPostings(tenantId: string): Promise<ServiceResult<JobPosting[]>> {
    return ok(await this.store.listJobPostings(tenantId));
  }

  async getJobPosting(tenantId: string, id: string): Promise<ServiceResult<JobPosting>> {
    if (!isValidUUID(id)) return fail(400, "Invalid ID");
    const row = await this.store.getJobPosting(tenantId, id);
    if (!row) return fail(404, "Not found");
    return ok(row);
  }

  async createJobPosting(
    tenantId: string,
    body: Record<string, unknown>,
  ): Promise<ServiceResult<JobPosting>> {
    const valid = validateJobPostingBody(body);
    if (!valid.ok) return fail(400, valid.error);

    const nowIso = this.now().toISOString();
    const row: JobPosting = {
      id: this.uuid(),
      tenant_id: tenantId,
      landing_page_id: (body.landing_page_id as string | null) ?? null,
      title: body.title as string,
      department: (body.department as string | null) ?? null,
      location: (body.location as string | null) ?? null,
      employment_type: (body.employment_type as JobPosting["employment_type"]) ?? "full_time",
      salary_range: (body.salary_range as string | null) ?? null,
      description_md: (body.description_md as string) ?? "",
      resume_required: (body.resume_required as boolean) ?? true,
      custom_questions: (body.custom_questions as CustomQuestion[]) ?? [],
      status: (body.status as JobPosting["status"]) ?? "draft",
      apply_deadline: (body.apply_deadline as string | null) ?? null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    await this.store.insertJobPosting(row);
    return ok(row);
  }

  async updateJobPosting(
    tenantId: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<ServiceResult<{ ok: true }>> {
    if (!isValidUUID(id)) return fail(400, "Invalid ID");
    const valid = validateJobPostingBody(body, { partial: true });
    if (!valid.ok) return fail(400, valid.error);

    const patch: Partial<JobPosting> = {};
    for (const key of [
      "title",
      "department",
      "location",
      "employment_type",
      "salary_range",
      "description_md",
      "resume_required",
      "custom_questions",
      "status",
      "apply_deadline",
      "landing_page_id",
    ] as const) {
      if (key in body) (patch as Record<string, unknown>)[key] = body[key];
    }
    if (Object.keys(patch).length === 0) return fail(400, "No fields to update");

    const done = await this.store.patchJobPosting(tenantId, id, patch);
    if (!done) return fail(400, "Failed to update job posting");
    return ok({ ok: true });
  }

  async deleteJobPosting(tenantId: string, id: string): Promise<ServiceResult<{ ok: true }>> {
    if (!isValidUUID(id)) return fail(400, "Invalid ID");
    const done = await this.store.deleteJobPosting(tenantId, id);
    if (!done) return fail(400, "Failed to delete");
    return ok({ ok: true });
  }

  // ─── Admin: applications ─────────────────────────────────────────────────────

  async listApplications(
    tenantId: string,
    postingId: string,
  ): Promise<ServiceResult<AdminApplication[]>> {
    if (!isValidUUID(postingId)) return fail(400, "Invalid ID");
    // Ensure posting belongs to tenant (prevents cross-tenant fishing).
    const posting = await this.store.getJobPosting(tenantId, postingId);
    if (!posting) return fail(404, "Not found");
    return ok(await this.store.listApplications(tenantId, postingId));
  }

  /** Update applicant status / notes (status transition). Records audit events. */
  async updateApplication(
    tenantId: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<ServiceResult<{ ok: true }>> {
    if (!isValidUUID(id)) return fail(400, "Invalid ID");
    const patch: Partial<Application> = {};
    if (typeof body.status === "string") {
      if (!isApplicationStatus(body.status)) return fail(400, "Invalid status");
      patch.status = body.status;
    }
    if (typeof body.notes_md === "string") patch.notes_md = body.notes_md;
    if (Object.keys(patch).length === 0) return fail(400, "No fields to update");

    const done = await this.store.patchApplication(tenantId, id, patch);
    if (!done) return fail(400, "Failed to update");

    if (patch.status) {
      await this.store.insertEvent(id, "status_changed", { new_status: patch.status });
    }
    if (patch.notes_md !== undefined) {
      await this.store.insertEvent(id, "note_added", {});
    }
    return ok({ ok: true });
  }

  // ─── Public: application submit ──────────────────────────────────────────────

  async submitApplication(
    slug: string,
    body: Record<string, unknown>,
    ipAddress: string | null,
  ): Promise<ServiceResult<{ application_id: string; gdpr_deletion_token: string }>> {
    // 1) landing page lookup (published + recruit)
    const lp = await this.store.getPublishedRecruitPage(slug);
    if (!lp) return fail(404, "Career page not found");

    // 2) validate job_posting
    const jobPostingId = typeof body.job_posting_id === "string" ? body.job_posting_id : null;
    if (!jobPostingId || !isValidUUID(jobPostingId)) {
      return fail(400, "job_posting_id is required");
    }
    const posting = await this.store.getPostingForTenant(lp.tenant_id, jobPostingId);
    if (!posting) return fail(404, "Job posting not found");
    if (posting.landing_page_id !== lp.id) {
      return fail(400, "Job posting does not belong to this career page");
    }
    if (posting.status !== "open") {
      return fail(400, "Job posting is not accepting applications");
    }
    if (posting.apply_deadline) {
      const deadline = new Date(posting.apply_deadline);
      if (!Number.isNaN(deadline.getTime()) && deadline.getTime() < this.now().getTime()) {
        return fail(400, "Application deadline has passed");
      }
    }

    // 3) applicant info
    const applicantName = typeof body.applicant_name === "string" ? body.applicant_name.trim() : "";
    const applicantEmail = typeof body.applicant_email === "string" ? body.applicant_email.trim() : "";
    if (!applicantName) return fail(400, "applicant_name is required");
    if (applicantName.length > MAX_APPLICANT_NAME_LEN) {
      return fail(400, `applicant_name exceeds max ${MAX_APPLICANT_NAME_LEN} characters`);
    }
    if (applicantEmail.length > MAX_APPLICANT_EMAIL_LEN || !EMAIL_RE.test(applicantEmail)) {
      return fail(400, "applicant_email is invalid");
    }

    // 4) resume
    const resumeAssetId =
      typeof body.resume_asset_id === "string" && isValidUUID(body.resume_asset_id)
        ? body.resume_asset_id
        : null;
    if (posting.resume_required && !resumeAssetId) {
      return fail(400, "resume is required for this job posting");
    }

    // 5) answers (OQ-2 B: max 10; required questions must be answered)
    const answersRaw = Array.isArray(body.answers) ? (body.answers as unknown[]) : [];
    if (answersRaw.length > MAX_CUSTOM_QUESTIONS) {
      return fail(400, `answers exceeds max ${MAX_CUSTOM_QUESTIONS}`);
    }
    const answers: ApplicationAnswer[] = [];
    for (const raw of answersRaw) {
      if (!raw || typeof raw !== "object") continue;
      const obj = raw as Record<string, unknown>;
      if (typeof obj.question_id !== "string" || typeof obj.answer !== "string") continue;
      if (obj.answer.length > MAX_ANSWER_LEN) {
        return fail(400, `answer exceeds max ${MAX_ANSWER_LEN} characters`);
      }
      answers.push({ question_id: obj.question_id, answer: obj.answer });
    }
    const questions = posting.custom_questions ?? [];
    for (const q of questions) {
      if (!q.required) continue;
      const found = answers.find((a) => a.question_id === q.id);
      if (!found || found.answer.trim() === "") {
        return fail(400, `required question missing: ${q.id}`);
      }
    }

    // 6) insert
    const nowIso = this.now().toISOString();
    const application: Application = {
      id: this.uuid(),
      tenant_id: lp.tenant_id,
      job_posting_id: posting.id,
      applicant_name: applicantName,
      applicant_email: applicantEmail,
      resume_asset_id: resumeAssetId,
      answers,
      status: "new",
      notes_md: "",
      ip_address: ipAddress,
      retention_expires_at: new Date(this.now().getTime() + this.retentionMs).toISOString(),
      gdpr_deletion_token: this.makeDeletionToken(),
      created_at: nowIso,
      updated_at: nowIso,
    };
    await this.store.insertApplication(application);

    // 7) audit event
    await this.store.insertEvent(application.id, "submitted", { job_posting_id: posting.id });

    // 8) notify (fire-and-forget in original; awaited here so callers can too)
    if (this.notifier) {
      const admins = await this.store.listAdminEmails(lp.tenant_id);
      if (admins.length > 0) {
        await this.notifier.notifyAdmins(posting, application, admins);
      }
      await this.notifier.notifyApplicant(posting, application);
    }

    // 9) respond with deletion token (applicant-only)
    return ok({
      application_id: application.id,
      gdpr_deletion_token: application.gdpr_deletion_token,
    });
  }

  // ─── Public: GDPR article 17 deletion ────────────────────────────────────────

  async applicantDeleteApplication(token: string): Promise<ServiceResult<{ ok: true }>> {
    if (!token || token.length < 16) return fail(400, "Invalid token");
    const row = await this.store.findApplicationByToken(token);
    if (!row) return fail(404, "Application not found");

    // audit first, then delete (audit is CASCADE, record before row disappears)
    await this.store.insertEvent(row.id, "deleted_by_applicant", {});
    const done = await this.store.deleteApplication(row.id);
    if (!done) return fail(500, "Failed to delete");
    return ok({ ok: true });
  }
}
