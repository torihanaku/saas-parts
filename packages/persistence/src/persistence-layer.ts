/**
 * Persistence layer — generic write-through CRUD over an injected DAL.
 *
 * Multiple routes had the same "query the DB with a scope filter" pattern
 * copy-pasted. This module centralises that logic as a generic PersistenceLayer<T>
 * class and convenience factories for the most common scoping columns.
 *
 * Ported from dev-dashboard-v2 server/lib/persistence-layer.ts. The project's
 * supabase wrapper import was replaced by an injected DalClient (see dal.ts).
 *
 * Usage:
 *   import { PersistenceLayer } from "@torihanaku/persistence";
 *
 *   const layer = new PersistenceLayer(dal, "backlog_items", "project_id", "my-project");
 *   await layer.save({ id: "abc", title: "Do something", status: "pending" });
 *   const items = await layer.list();
 */

import type { DalClient, DalResult } from "./dal";

// ─── Generic write-through layer ──────────────────────────────────────────────

export interface PersistenceOptions {
  /** Soft-delete: PATCH status to "deleted" instead of real DELETE. Default: false */
  softDelete?: boolean;
}

export class PersistenceLayer<T extends Record<string, unknown>> {
  constructor(
    private readonly dal: DalClient,
    private readonly table: string,
    private readonly filterColumn: string,
    private readonly filterValue: string,
    private readonly options: PersistenceOptions = {},
  ) {}

  /**
   * PostgREST clause that excludes rows this layer's `remove()` flags as
   * deleted. Reads MUST apply it, otherwise "removed" rows keep coming back
   * (`remove()` never issues a true DELETE — it flags the row).
   *
   *  - softDelete mode → remove() sets `status = "deleted"`  → exclude those.
   *  - default (hard)  → remove() sets `deleted = true`      → exclude those.
   *
   * `not.is.true` / `neq` keep the safe path: a row is only hidden once it has
   * been explicitly flagged.
   */
  private notDeletedClause(): string {
    return this.options.softDelete ? "status=neq.deleted" : "deleted=not.is.true";
  }

  /** Fetch all records matching the filter (excludes soft/flag-deleted rows). */
  async list(extraQuery = ""): Promise<T[]> {
    try {
      const query = `${this.filterColumn}=eq.${encodeURIComponent(this.filterValue)}&${this.notDeletedClause()}${extraQuery ? `&${extraQuery}` : ""}`;
      const rows = await this.dal.get(this.table, query);
      return (rows ?? []) as T[];
    } catch {
      return [];
    }
  }

  /** Fetch a single record by ID (excludes soft/flag-deleted rows). */
  async get(id: string): Promise<T | null> {
    try {
      const rows = await this.dal.get(
        this.table,
        `id=eq.${encodeURIComponent(id)}&${this.filterColumn}=eq.${encodeURIComponent(this.filterValue)}&${this.notDeletedClause()}&limit=1`,
      );
      return (rows?.[0] as T) ?? null;
    } catch {
      return null;
    }
  }

  /** Insert a new record. Returns true on success. */
  async save(data: T): Promise<boolean> {
    try {
      const result = await this.dal.insert(this.table, {
        ...data,
        [this.filterColumn]: this.filterValue,
      });
      return result.ok;
    } catch {
      return false;
    }
  }

  /** Update an existing record by ID. Returns true on success. */
  async update(id: string, patch: Partial<T>): Promise<boolean> {
    try {
      const result = await this.dal.patch(
        this.table,
        `id=eq.${encodeURIComponent(id)}&${this.filterColumn}=eq.${encodeURIComponent(this.filterValue)}`,
        { ...patch, updated_at: new Date().toISOString() },
      );
      return result.ok;
    } catch {
      return false;
    }
  }

  /** Remove a record (hard delete or soft delete via status="deleted"). */
  async remove(id: string): Promise<boolean> {
    if (this.options.softDelete) {
      return this.update(id, { status: "deleted" } as unknown as Partial<T>);
    }
    try {
      // Use PATCH with a "deleted" flag to keep parity with the original layer,
      // which never issued a true DELETE. Callers that need a hard DELETE
      // should use dal.delete directly.
      const result = await this.dal.patch(
        this.table,
        `id=eq.${encodeURIComponent(id)}&${this.filterColumn}=eq.${encodeURIComponent(this.filterValue)}`,
        { deleted: true, deleted_at: new Date().toISOString() },
      );
      return result.ok;
    } catch {
      return false;
    }
  }
}

// ─── Upsert helper ────────────────────────────────────────────────────────────

/**
 * Insert or update a record based on whether a row matching `filter` exists.
 * Convenient for settings-style tables (0 or 1 rows per owner).
 */
export async function upsert(
  dal: DalClient,
  table: string,
  filter: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  try {
    const existing = await dal.get(table, `${filter}&limit=1`);
    if (existing?.length) {
      const result = await dal.patch(table, filter, {
        ...data,
        updated_at: new Date().toISOString(),
      });
      return result.ok;
    }
    const result = await dal.insert(table, {
      ...data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return result.ok;
  } catch {
    return false;
  }
}

// ─── Safe batch operations ────────────────────────────────────────────────────

/**
 * Insert multiple records, returning the count of successful insertions.
 */
export async function batchInsert(
  dal: DalClient,
  table: string,
  records: Record<string, unknown>[],
): Promise<number> {
  const results = await Promise.allSettled(
    records.map((r) => dal.insert(table, r)),
  );
  return results.filter(
    (r): r is PromiseFulfilledResult<DalResult> =>
      r.status === "fulfilled" && r.value.ok,
  ).length;
}

// ─── Typed convenience factories ──────────────────────────────────────────────

/** Layer for a project-scoped table (filter: project_id=<id>). */
export function projectLayer<T extends Record<string, unknown>>(
  dal: DalClient,
  table: string,
  projectId: string,
  options?: PersistenceOptions,
): PersistenceLayer<T> {
  return new PersistenceLayer<T>(dal, table, "project_id", projectId, options);
}

/** Layer for a user-scoped table (filter: user_id=<id>). */
export function userLayer<T extends Record<string, unknown>>(
  dal: DalClient,
  table: string,
  userId: string,
  options?: PersistenceOptions,
): PersistenceLayer<T> {
  return new PersistenceLayer<T>(dal, table, "user_id", userId, options);
}

/** Layer for a tenant-scoped table (filter: tenant_id=<id>). */
export function tenantLayer<T extends Record<string, unknown>>(
  dal: DalClient,
  table: string,
  tenantId: string,
  options?: PersistenceOptions,
): PersistenceLayer<T> {
  return new PersistenceLayer<T>(dal, table, "tenant_id", tenantId, options);
}
