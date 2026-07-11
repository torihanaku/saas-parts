/**
 * Storage ports for the approval workflow, plus in-memory reference
 * implementations (usable directly in tests / prototypes).
 *
 * The original implementation persisted to Supabase tables
 * (dd_submissions / dd_exception_requests); the kit talks only to these
 * interfaces so any backend (Postgres, Firestore, in-memory, ...) can be
 * plugged in.
 */
import type { ExceptionRequest, Submission, SubmissionStatus } from "./types.js";

export interface SubmissionListFilter {
  tenantId: string;
  /** 'submitter' / 'approver' scoping (original list route `role` query). */
  submitterId?: string;
  approverId?: string;
  status?: SubmissionStatus;
}

export interface SubmissionStore {
  insert(row: Submission): Promise<Submission>;
  getById(id: string, tenantId: string): Promise<Submission | null>;
  /** Partial update scoped by tenant. Returns the updated row or null when missing. */
  update(
    id: string,
    tenantId: string,
    patch: Partial<Omit<Submission, "id" | "tenantId">>,
  ): Promise<Submission | null>;
  list(filter: SubmissionListFilter): Promise<Submission[]>;
  /**
   * Cross-tenant scan used by the escalation job: submissions in one of
   * `statuses` whose submittedAt is older than `cutoffIso`.
   */
  listPendingOlderThan(statuses: readonly SubmissionStatus[], cutoffIso: string): Promise<Submission[]>;
}

export interface ExceptionRequestStore {
  insert(row: ExceptionRequest): Promise<ExceptionRequest>;
  getById(id: string, tenantId: string): Promise<ExceptionRequest | null>;
  update(
    id: string,
    tenantId: string,
    patch: Partial<Omit<ExceptionRequest, "id" | "tenantId">>,
  ): Promise<ExceptionRequest | null>;
  list(
    tenantId: string,
    filter?: { decision?: "approved" | "rejected" | "pending" | "all" },
  ): Promise<ExceptionRequest[]>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* In-memory reference implementations                                        */
/* ────────────────────────────────────────────────────────────────────────── */

export class InMemorySubmissionStore implements SubmissionStore {
  private rows = new Map<string, Submission>();

  async insert(row: Submission): Promise<Submission> {
    this.rows.set(row.id, { ...row });
    return { ...row };
  }

  async getById(id: string, tenantId: string): Promise<Submission | null> {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId ? { ...row } : null;
  }

  async update(
    id: string,
    tenantId: string,
    patch: Partial<Omit<Submission, "id" | "tenantId">>,
  ): Promise<Submission | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return { ...next };
  }

  async list(filter: SubmissionListFilter): Promise<Submission[]> {
    return [...this.rows.values()]
      .filter((r) => r.tenantId === filter.tenantId)
      .filter((r) => (filter.submitterId ? r.submitterId === filter.submitterId : true))
      .filter((r) => (filter.approverId ? r.approverId === filter.approverId : true))
      .filter((r) => (filter.status ? r.status === filter.status : true))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((r) => ({ ...r }));
  }

  async listPendingOlderThan(
    statuses: readonly SubmissionStatus[],
    cutoffIso: string,
  ): Promise<Submission[]> {
    return [...this.rows.values()]
      .filter((r) => statuses.includes(r.status) && r.submittedAt !== null && r.submittedAt < cutoffIso)
      .map((r) => ({ ...r }));
  }
}

export class InMemoryExceptionRequestStore implements ExceptionRequestStore {
  private rows = new Map<string, ExceptionRequest>();

  async insert(row: ExceptionRequest): Promise<ExceptionRequest> {
    this.rows.set(row.id, { ...row });
    return { ...row };
  }

  async getById(id: string, tenantId: string): Promise<ExceptionRequest | null> {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId ? { ...row } : null;
  }

  async update(
    id: string,
    tenantId: string,
    patch: Partial<Omit<ExceptionRequest, "id" | "tenantId">>,
  ): Promise<ExceptionRequest | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return { ...next };
  }

  async list(
    tenantId: string,
    filter?: { decision?: "approved" | "rejected" | "pending" | "all" },
  ): Promise<ExceptionRequest[]> {
    const decision = filter?.decision ?? "pending";
    return [...this.rows.values()]
      .filter((r) => r.tenantId === tenantId)
      .filter((r) => {
        if (decision === "all") return true;
        if (decision === "pending") return r.decision === null;
        return r.decision === decision;
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((r) => ({ ...r }));
  }
}
