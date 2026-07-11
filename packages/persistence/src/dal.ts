/**
 * Minimal DAL (data access layer) contract that PersistenceLayer depends on.
 *
 * Defined locally so this package is self-contained. Any PostgREST-style
 * wrapper works — e.g. @torihanaku/supabase-dal's SupabaseDal satisfies this
 * shape structurally (get / insert / patch with the same signatures).
 */

/** Result of a write operation. Only `ok` is consumed by this package. */
export interface DalResult {
  ok: boolean;
  data?: unknown[];
  error?: string;
  status?: number;
}

export interface DalClient {
  /** SELECT: `query` is a PostgREST-style query string (e.g. "id=eq.1&limit=1"). Null on failure. */
  get(table: string, query?: string): Promise<unknown[] | null>;
  /** INSERT a single record. */
  insert(table: string, data: Record<string, unknown>): Promise<DalResult>;
  /** UPDATE records matching `filter` (PostgREST-style filter string). */
  patch(table: string, filter: string, data: Record<string, unknown>): Promise<DalResult>;
  /** Optional hard DELETE — not used by PersistenceLayer (remove() flags rows via patch). */
  delete?(table: string, filter: string): Promise<DalResult>;
}
