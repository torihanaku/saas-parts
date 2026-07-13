import { describe, it, expect, beforeEach, vi } from "vitest";
import { HiringService } from "./service";
import { InMemoryHiringStore } from "./store";
import { renderGdprDeletePage } from "./gdpr-delete-page";
import {
  isApplicationStatus,
  isJobPostingStatus,
  validateCustomQuestions,
  validateJobPostingBody,
  MAX_CUSTOM_QUESTIONS,
  MAX_APPLICANT_NAME_LEN,
  MAX_APPLICANT_EMAIL_LEN,
  MAX_ANSWER_LEN,
  type CustomQuestion,
  type JobPosting,
} from "./types";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function makeService(store = new InMemoryHiringStore()) {
  let n = 0;
  const svc = new HiringService({
    store,
    uuid: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    },
    now: () => new Date("2026-07-11T00:00:00Z"),
    makeDeletionToken: () => "tok_deterministic_1234567890",
  });
  return { svc, store };
}

// ─── guards / validators (ported from recruitment-foundation.test.ts) ─────────

describe("type guards", () => {
  it.each(["new", "reviewing", "interview", "offered", "rejected"])(
    "isApplicationStatus('%s')",
    (s) => expect(isApplicationStatus(s)).toBe(true),
  );
  it.each(["draft", "open", "closed"])("isJobPostingStatus('%s')", (s) =>
    expect(isJobPostingStatus(s)).toBe(true),
  );
  it("rejects unknown", () => {
    expect(isApplicationStatus("hired")).toBe(false);
    expect(isJobPostingStatus("archived")).toBe(false);
  });
});

describe("validateCustomQuestions (max 10)", () => {
  const sample = (n: number): CustomQuestion[] =>
    Array.from({ length: n }, (_, i) => ({ id: `q${i}`, label: `Q${i}`, type: "text", required: false }));
  it("accepts exactly 10", () => expect(validateCustomQuestions(sample(10))).toEqual({ ok: true }));
  it("rejects 11", () => expect(validateCustomQuestions(sample(11)).ok).toBe(false));
  it("MAX is 10", () => expect(MAX_CUSTOM_QUESTIONS).toBe(10));
});

describe("validateJobPostingBody", () => {
  it("requires title", () => expect(validateJobPostingBody({}).ok).toBe(false));
  it("accepts valid", () => expect(validateJobPostingBody({ title: "Eng" }).ok).toBe(true));
  it("rejects bad employment_type", () =>
    expect(validateJobPostingBody({ title: "x", employment_type: "gig" }).ok).toBe(false));
  it("partial skips title", () => expect(validateJobPostingBody({ status: "open" }, { partial: true }).ok).toBe(true));
});

// ─── job posting CRUD ─────────────────────────────────────────────────────────

describe("job posting CRUD", () => {
  let svc: HiringService;
  let store: InMemoryHiringStore;
  beforeEach(() => ({ svc, store } = makeService()));

  it("creates and lists postings scoped by tenant", async () => {
    const created = await svc.createJobPosting("t1", { title: "Engineer", status: "open" });
    expect(created.ok).toBe(true);
    await svc.createJobPosting("t2", { title: "Other" });
    const list = await svc.listJobPostings("t1");
    expect(list.ok && list.data.length).toBe(1);
    expect(list.ok && list.data[0]!.title).toBe("Engineer");
  });

  it("rejects invalid create body", async () => {
    const r = await svc.createJobPosting("t1", { title: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("get returns 404 for other tenant", async () => {
    const c = await svc.createJobPosting("t1", { title: "X" });
    const id = c.ok ? c.data.id : "";
    const other = await svc.getJobPosting("t2", id);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.status).toBe(404);
  });

  it("update patches fields, rejects empty patch", async () => {
    const c = await svc.createJobPosting("t1", { title: "X" });
    const id = c.ok ? c.data.id : "";
    expect((await svc.updateJobPosting("t1", id, { status: "open" })).ok).toBe(true);
    expect((await store.getJobPosting("t1", id))!.status).toBe("open");
    const empty = await svc.updateJobPosting("t1", id, {});
    expect(empty.ok).toBe(false);
  });

  it("delete removes posting", async () => {
    const c = await svc.createJobPosting("t1", { title: "X" });
    const id = c.ok ? c.data.id : "";
    expect((await svc.deleteJobPosting("t1", id)).ok).toBe(true);
    expect(await store.getJobPosting("t1", id)).toBeNull();
  });

  it("rejects non-UUID ids", async () => {
    expect((await svc.getJobPosting("t1", "nope")).ok).toBe(false);
    expect((await svc.deleteJobPosting("t1", "nope")).ok).toBe(false);
  });
});

// ─── applicant tracking / status transitions ─────────────────────────────────

describe("application tracking", () => {
  it("lists applications only after posting ownership check", async () => {
    const { svc } = makeService();
    const bad = await svc.listApplications("t1", UUID_A);
    expect(bad.ok).toBe(false); // posting not owned
    if (!bad.ok) expect(bad.status).toBe(404);
  });

  it("updates status, records audit events, hides token", async () => {
    const store = new InMemoryHiringStore();
    const { svc } = makeService(store);
    const c = await svc.createJobPosting("t1", { title: "X" });
    const postingId = c.ok ? c.data.id : "";
    await store.insertApplication({
      id: UUID_A,
      tenant_id: "t1",
      job_posting_id: postingId,
      applicant_name: "Ann",
      applicant_email: "ann@example.com",
      resume_asset_id: null,
      answers: [],
      status: "new",
      notes_md: "",
      ip_address: "1.2.3.4",
      retention_expires_at: "2028-01-01T00:00:00Z",
      gdpr_deletion_token: "secret-token",
      created_at: "2026-07-11T00:00:00Z",
      updated_at: "2026-07-11T00:00:00Z",
    });
    const upd = await svc.updateApplication("t1", UUID_A, { status: "interview", notes_md: "good" });
    expect(upd.ok).toBe(true);
    expect(store.events.map((e) => e.event_type)).toEqual(["status_changed", "note_added"]);

    const list = await svc.listApplications("t1", postingId);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.data[0]!.status).toBe("interview");
      expect("gdpr_deletion_token" in list.data[0]!).toBe(false);
      expect("ip_address" in list.data[0]!).toBe(false);
    }
  });

  it("rejects invalid status", async () => {
    const { svc } = makeService();
    const r = await svc.updateApplication("t1", UUID_A, { status: "hired" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

// ─── public apply flow ────────────────────────────────────────────────────────

function seedPublic(store: InMemoryHiringStore, overrides: Partial<JobPosting> = {}) {
  store.pages.set("lp1", {
    id: "lp1",
    slug: "careers",
    tenant_id: "t1",
    category: "recruit",
    published: true,
  });
  const posting: JobPosting = {
    id: UUID_A,
    tenant_id: "t1",
    landing_page_id: "lp1",
    title: "Engineer",
    department: null,
    location: null,
    employment_type: "full_time",
    salary_range: null,
    description_md: "",
    resume_required: false,
    custom_questions: [],
    status: "open",
    apply_deadline: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
  store.postings.set(posting.id, posting);
  store.adminEmails.set("t1", ["admin@example.com"]);
  return posting;
}

describe("public application submit", () => {
  it("submits a valid application and returns a deletion token", async () => {
    const store = new InMemoryHiringStore();
    seedPublic(store);
    const notify = { notifyAdmins: vi.fn(), notifyApplicant: vi.fn() };
    const svc = new HiringService({ store, notifier: notify, makeDeletionToken: () => "TOK" });
    const r = await svc.submitApplication(
      "careers",
      { job_posting_id: UUID_A, applicant_name: "Bob", applicant_email: "bob@example.com" },
      "9.9.9.9",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.gdpr_deletion_token).toBe("TOK");
    expect(store.applications.size).toBe(1);
    expect(store.events.some((e) => e.event_type === "submitted")).toBe(true);
    expect(notify.notifyAdmins).toHaveBeenCalledOnce();
    expect(notify.notifyApplicant).toHaveBeenCalledOnce();
  });

  it("404 for unpublished / missing career page", async () => {
    const { svc } = makeService();
    const r = await svc.submitApplication("careers", { job_posting_id: UUID_A }, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("rejects when posting not open", async () => {
    const store = new InMemoryHiringStore();
    seedPublic(store, { status: "draft" });
    const { svc } = makeService(store);
    const r = await svc.submitApplication(
      "careers",
      { job_posting_id: UUID_A, applicant_name: "B", applicant_email: "b@x.co" },
      null,
    );
    expect(r.ok).toBe(false);
  });

  it("enforces resume_required", async () => {
    const store = new InMemoryHiringStore();
    seedPublic(store, { resume_required: true });
    const { svc } = makeService(store);
    const r = await svc.submitApplication(
      "careers",
      { job_posting_id: UUID_A, applicant_name: "B", applicant_email: "b@x.co" },
      null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/resume/);
  });

  it("enforces required custom questions", async () => {
    const store = new InMemoryHiringStore();
    seedPublic(store, {
      custom_questions: [{ id: "why", label: "Why?", type: "textarea", required: true }],
    });
    const { svc } = makeService(store);
    const missing = await svc.submitApplication(
      "careers",
      { job_posting_id: UUID_A, applicant_name: "B", applicant_email: "b@x.co" },
      null,
    );
    expect(missing.ok).toBe(false);
    const ok = await svc.submitApplication(
      "careers",
      {
        job_posting_id: UUID_A,
        applicant_name: "B",
        applicant_email: "b@x.co",
        answers: [{ question_id: "why", answer: "because" }],
      },
      null,
    );
    expect(ok.ok).toBe(true);
  });

  it("rejects invalid email", async () => {
    const store = new InMemoryHiringStore();
    seedPublic(store);
    const { svc } = makeService(store);
    const r = await svc.submitApplication(
      "careers",
      { job_posting_id: UUID_A, applicant_name: "B", applicant_email: "not-an-email" },
      null,
    );
    expect(r.ok).toBe(false);
  });

  // Regression: the PUBLIC (unauthenticated) intake previously stored
  // arbitrarily large applicant-supplied strings, allowing storage-abuse / DoS.
  it("rejects oversized applicant_name and never persists it", async () => {
    const store = new InMemoryHiringStore();
    seedPublic(store);
    const { svc } = makeService(store);
    const r = await svc.submitApplication(
      "careers",
      {
        job_posting_id: UUID_A,
        applicant_name: "x".repeat(MAX_APPLICANT_NAME_LEN + 1),
        applicant_email: "b@x.co",
      },
      null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(store.applications.size).toBe(0);
  });

  it("rejects oversized applicant_email", async () => {
    const store = new InMemoryHiringStore();
    seedPublic(store);
    const { svc } = makeService(store);
    const local = "a".repeat(MAX_APPLICANT_EMAIL_LEN);
    const r = await svc.submitApplication(
      "careers",
      { job_posting_id: UUID_A, applicant_name: "B", applicant_email: `${local}@x.co` },
      null,
    );
    expect(r.ok).toBe(false);
    expect(store.applications.size).toBe(0);
  });

  it("rejects oversized answer and never persists it", async () => {
    const store = new InMemoryHiringStore();
    seedPublic(store);
    const { svc } = makeService(store);
    const r = await svc.submitApplication(
      "careers",
      {
        job_posting_id: UUID_A,
        applicant_name: "B",
        applicant_email: "b@x.co",
        answers: [{ question_id: "q", answer: "y".repeat(MAX_ANSWER_LEN + 1) }],
      },
      null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
    expect(store.applications.size).toBe(0);
  });

  it("accepts applicant fields at the boundary limits", async () => {
    const store = new InMemoryHiringStore();
    seedPublic(store);
    const { svc } = makeService(store);
    const r = await svc.submitApplication(
      "careers",
      {
        job_posting_id: UUID_A,
        applicant_name: "n".repeat(MAX_APPLICANT_NAME_LEN),
        applicant_email: "b@x.co",
        answers: [{ question_id: "q", answer: "y".repeat(MAX_ANSWER_LEN) }],
      },
      null,
    );
    expect(r.ok).toBe(true);
    expect(store.applications.size).toBe(1);
  });
});

// ─── GDPR deletion ────────────────────────────────────────────────────────────

describe("applicant GDPR deletion", () => {
  it("deletes by token and records audit event", async () => {
    const store = new InMemoryHiringStore();
    seedPublic(store);
    const svc = new HiringService({ store, makeDeletionToken: () => "the-token-1234567" });
    await svc.submitApplication(
      "careers",
      { job_posting_id: UUID_A, applicant_name: "B", applicant_email: "b@x.co" },
      null,
    );
    expect(store.applications.size).toBe(1);
    const r = await svc.applicantDeleteApplication("the-token-1234567");
    expect(r.ok).toBe(true);
    expect(store.applications.size).toBe(0);
    expect(store.events.some((e) => e.event_type === "deleted_by_applicant")).toBe(true);
  });

  it("rejects short tokens and unknown tokens", async () => {
    const { svc } = makeService();
    expect((await svc.applicantDeleteApplication("short")).ok).toBe(false);
    const unknown = await svc.applicantDeleteApplication("this-is-long-enough-token");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.status).toBe(404);
  });
});

describe("renderGdprDeletePage", () => {
  it("renders confirmation HTML with the delete endpoint", () => {
    const html = renderGdprDeletePage("abc123");
    expect(html).toContain("応募データの削除");
    expect(html).toContain("/api/careers/applications/abc123");
  });
  it("honors a custom deleteUrl", () => {
    expect(renderGdprDeletePage("t", { deleteUrl: "/x/y" })).toContain("'/x/y'");
  });
});

describe("default deletion token generator", () => {
  it("produces url-safe unique tokens", () => {
    const store = new InMemoryHiringStore();
    const svc = new HiringService({ store });
    const a = (svc as unknown as { makeDeletionToken: () => string }).makeDeletionToken();
    const b = (svc as unknown as { makeDeletionToken: () => string }).makeDeletionToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
