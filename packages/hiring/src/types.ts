/**
 * Recruitment / hiring domain types.
 * Ported from dev-dashboard-v2 `shared/types/recruitment.ts` (#776 R-1).
 */

// ─── Job posting ───────────────────────────────────────────────────────────

export type EmploymentType = "full_time" | "part_time" | "contract" | "intern";

export type JobPostingStatus = "draft" | "open" | "closed";

export type CustomQuestionFieldType = "text" | "textarea" | "select";

export interface CustomQuestion {
  id: string;
  label: string;
  type: CustomQuestionFieldType;
  required: boolean;
  options?: string[];
}

/** OQ-2 B: MVP で enforce する上限 */
export const MAX_CUSTOM_QUESTIONS = 10;

export interface JobPosting {
  id: string;
  tenant_id: string;
  landing_page_id: string | null;
  title: string;
  department: string | null;
  location: string | null;
  employment_type: EmploymentType;
  salary_range: string | null;
  description_md: string;
  resume_required: boolean;
  custom_questions: CustomQuestion[];
  status: JobPostingStatus;
  apply_deadline: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Application ───────────────────────────────────────────────────────────

export type ApplicationStatus =
  | "new"
  | "reviewing"
  | "interview"
  | "offered"
  | "rejected";

export interface ApplicationAnswer {
  question_id: string;
  answer: string;
}

export interface Application {
  id: string;
  tenant_id: string;
  job_posting_id: string;
  applicant_name: string;
  applicant_email: string;
  resume_asset_id: string | null;
  answers: ApplicationAnswer[];
  status: ApplicationStatus;
  notes_md: string;
  ip_address: string | null;
  /** OQ-9 B: GDPR retention deadline (default 2y, tenant-configurable). */
  retention_expires_at: string;
  /** OQ-9 C: deletion URL token (exposed only to applicant, not admin UI). */
  gdpr_deletion_token: string;
  created_at: string;
  updated_at: string;
}

/** Admin-safe application view (excludes gdpr_deletion_token + ip_address). */
export type AdminApplication = Omit<Application, "gdpr_deletion_token" | "ip_address">;

// ─── Application events (audit trail) ──────────────────────────────────────

export type ApplicationEventType =
  | "submitted"
  | "status_changed"
  | "note_added"
  | "deleted_by_applicant"
  | "deleted_by_retention";

export interface ApplicationEvent {
  id: string;
  application_id: string;
  event_type: ApplicationEventType;
  by_user_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
}

/** Public career landing page (published + category=recruit gate). */
export interface LandingPageRow {
  id: string;
  slug: string;
  tenant_id: string;
  category: string;
  published: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

export function isApplicationStatus(v: string): v is ApplicationStatus {
  return (
    v === "new" ||
    v === "reviewing" ||
    v === "interview" ||
    v === "offered" ||
    v === "rejected"
  );
}

export function isJobPostingStatus(v: string): v is JobPostingStatus {
  return v === "draft" || v === "open" || v === "closed";
}

/** OQ-2 B を enforce。 */
export function validateCustomQuestions(
  questions: unknown[],
): { ok: true } | { ok: false; error: string } {
  if (!Array.isArray(questions)) return { ok: false, error: "custom_questions must be array" };
  if (questions.length > MAX_CUSTOM_QUESTIONS) {
    return { ok: false, error: `custom_questions exceeds max ${MAX_CUSTOM_QUESTIONS}` };
  }
  return { ok: true };
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidUUID(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export function validateJobPostingBody(
  body: Record<string, unknown>,
  opts: { partial?: boolean } = {},
): { ok: true } | { ok: false; error: string } {
  const partial = opts.partial === true;

  if (!partial || "title" in body) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return { ok: false, error: "title is required" };
    }
  }
  if ("employment_type" in body) {
    const et = body.employment_type;
    if (typeof et !== "string" || !["full_time", "part_time", "contract", "intern"].includes(et)) {
      return { ok: false, error: "employment_type invalid" };
    }
  }
  if ("status" in body) {
    if (typeof body.status !== "string" || !isJobPostingStatus(body.status)) {
      return { ok: false, error: "status invalid" };
    }
  }
  if ("custom_questions" in body) {
    const q = body.custom_questions;
    if (!Array.isArray(q)) return { ok: false, error: "custom_questions must be array" };
    const valid = validateCustomQuestions(q);
    if (!valid.ok) return valid;
    for (const item of q) {
      if (!item || typeof item !== "object") {
        return { ok: false, error: "custom_question item invalid" };
      }
      const obj = item as Record<string, unknown>;
      if (typeof obj.id !== "string" || typeof obj.label !== "string" || typeof obj.type !== "string") {
        return { ok: false, error: "custom_question shape invalid" };
      }
      if (!["text", "textarea", "select"].includes(obj.type)) {
        return { ok: false, error: "custom_question type invalid" };
      }
    }
  }
  if ("apply_deadline" in body && body.apply_deadline !== null) {
    if (typeof body.apply_deadline !== "string") {
      return { ok: false, error: "apply_deadline must be YYYY-MM-DD string or null" };
    }
  }
  return { ok: true };
}
