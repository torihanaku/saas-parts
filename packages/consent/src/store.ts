/**
 * ConsentStore — persistence boundary for the consent registry.
 * The source read/wrote the Supabase `sup_consent_registry` table
 * (see README for the schema) and used `supabaseDelete` for the
 * revocation cascade; here everything is an injected interface.
 */
import type { ConsentBasis, ConsentRecord } from "./types";

export interface ConsentStoreResult {
  ok: boolean;
  error?: string;
}

export interface ConsentStore {
  /**
   * True iff an active (revoked_at IS NULL) consent row exists.
   * Source query: tenant_id=eq.X&user_id=eq.Y&purpose=eq.Z&revoked_at=is.null&limit=1
   */
  hasActiveConsent(tenantId: string, userId: string, purpose: string): Promise<boolean>;
  /** Record a grant (source route inserted into sup_consent_registry). */
  grant(record: ConsentRecord): Promise<ConsentStoreResult>;
  /** Set revoked_at on the active row (source route PATCHed revoked_at). */
  revoke(
    tenantId: string,
    userId: string,
    purpose: string,
    revokedAtIso: string,
  ): Promise<ConsentStoreResult>;
  /**
   * DELETE FROM table WHERE every filter column equals its value —
   * used by the revocation cascade (source: `supabaseDelete(table, filter)`).
   */
  deleteRows(table: string, filters: Record<string, string>): Promise<ConsentStoreResult>;
}

/** In-memory reference implementation (tests / local dev). */
export class InMemoryConsentStore implements ConsentStore {
  readonly records: ConsentRecord[] = [];
  /** Cascade-purge target tables. */
  readonly tables = new Map<string, Record<string, unknown>[]>();

  seed(table: string, rows: Record<string, unknown>[]): void {
    this.tables.set(table, [...rows]);
  }

  async hasActiveConsent(tenantId: string, userId: string, purpose: string): Promise<boolean> {
    return this.records.some(
      (r) =>
        r.tenantId === tenantId &&
        r.userId === userId &&
        r.purpose === purpose &&
        (r.revokedAt === undefined || r.revokedAt === null),
    );
  }

  async grant(record: ConsentRecord): Promise<ConsentStoreResult> {
    const existing = this.records.find(
      (r) =>
        r.tenantId === record.tenantId &&
        r.userId === record.userId &&
        r.purpose === record.purpose,
    );
    if (existing) {
      existing.basis = record.basis as ConsentBasis;
      existing.grantedAt = record.grantedAt;
      existing.revokedAt = null;
    } else {
      this.records.push({ ...record });
    }
    return { ok: true };
  }

  async revoke(
    tenantId: string,
    userId: string,
    purpose: string,
    revokedAtIso: string,
  ): Promise<ConsentStoreResult> {
    const existing = this.records.find(
      (r) => r.tenantId === tenantId && r.userId === userId && r.purpose === purpose,
    );
    if (!existing) return { ok: false, error: "consent not found" };
    existing.revokedAt = revokedAtIso;
    return { ok: true };
  }

  async deleteRows(table: string, filters: Record<string, string>): Promise<ConsentStoreResult> {
    const rows = this.tables.get(table) ?? [];
    const remaining = rows.filter(
      (row) => !Object.entries(filters).every(([col, val]) => String(row[col]) === val),
    );
    this.tables.set(table, remaining);
    return { ok: true };
  }
}
