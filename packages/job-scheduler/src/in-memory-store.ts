/**
 * In-memory JobStateStore — default-quality reference implementation.
 * Mirrors the update-then-insert-fallback semantics of the original
 * Supabase-backed `dd_scheduled_jobs` table.
 */
import type { JobStateStore, PersistedJobRow } from "./types";

export type StoredJobRow = PersistedJobRow & { created_at?: string };

export class InMemoryJobStateStore implements JobStateStore {
  private readonly rows: Map<string, StoredJobRow> = new Map();

  async update(name: string, row: PersistedJobRow): Promise<boolean> {
    const existing = this.rows.get(name);
    if (!existing) return false;
    this.rows.set(name, { ...existing, ...row });
    return true;
  }

  async insert(row: PersistedJobRow & { created_at: string }): Promise<void> {
    this.rows.set(row.name, { ...row });
  }

  async loadEnabled(name: string): Promise<boolean | null> {
    const row = this.rows.get(name);
    return row ? row.enabled : null;
  }

  /** Inspection helper (not part of JobStateStore). */
  getRow(name: string): StoredJobRow | undefined {
    return this.rows.get(name);
  }

  /** Inspection helper (not part of JobStateStore). */
  getRows(): StoredJobRow[] {
    return Array.from(this.rows.values());
  }
}
