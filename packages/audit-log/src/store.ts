/**
 * AuditStore — persistence boundary for the audit log.
 * Source used Supabase REST (`audit_log` table, append-only via RLS);
 * here it is an injected interface with an in-memory reference implementation.
 */

export interface AuditStoreResult {
  ok: boolean;
  error?: string;
}

/**
 * Row shape persisted to the audit log table.
 * `prev_hash` / `entry_hash` are base64-encoded SHA-256 digests.
 * Other fields mirror the source `audit_log` columns (tenant_id, user_email,
 * user_role, action, resource_type, resource_id, changes, ip_address,
 * actor_type, approval_hash, exec_hash, risk_level, archived_to_gcs, occurred_at).
 */
export type AuditRow = Record<string, unknown> & {
  tenant_id: string;
  occurred_at: string;
  prev_hash: string | null;
  entry_hash: string;
};

export interface AuditStore {
  /**
   * Latest entry for the tenant.
   * Equivalent of source query `tenant_id=eq.X&order=occurred_at.desc&limit=1`.
   */
  getLastEntry(tenantId: string): Promise<AuditRow | null>;
  /** Append-only insert (the table MUST reject updates/deletes at the DB layer). */
  insert(row: AuditRow): Promise<AuditStoreResult>;
  /**
   * All entries for the tenant in `occurred_at` ascending order
   * (used by the hash-chain verifier).
   */
  listEntries(tenantId: string): Promise<AuditRow[]>;
}

/**
 * In-memory implementation, mainly for tests / local development.
 * `rows` is intentionally public so tests can simulate tampering.
 */
export class InMemoryAuditStore implements AuditStore {
  /** Public on purpose: tamper-detection tests mutate rows directly. */
  readonly rows: AuditRow[] = [];

  async getLastEntry(tenantId: string): Promise<AuditRow | null> {
    let last: AuditRow | null = null;
    for (const row of this.rows) {
      if (row.tenant_id !== tenantId) continue;
      // `>=` so that among same-timestamp rows the most recently inserted wins,
      // matching insertion order.
      if (last === null || row.occurred_at >= last.occurred_at) last = row;
    }
    return last;
  }

  async insert(row: AuditRow): Promise<AuditStoreResult> {
    this.rows.push(row);
    return { ok: true };
  }

  async listEntries(tenantId: string): Promise<AuditRow[]> {
    // Stable sort: same-timestamp rows keep insertion order.
    return this.rows
      .filter((r) => r.tenant_id === tenantId)
      .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0));
  }
}
