/**
 * Injected persistence interface for OAuth connections.
 *
 * The original oauth-manager persisted connections through the product's
 * Supabase REST helpers (`supabaseInsert`/`supabasePatch`/`supabaseGet`).
 * This interface mirrors those call shapes (including the PostgREST-style
 * `key=eq.value` filter strings) so a Supabase-backed implementation is a
 * thin adapter, while the in-memory default keeps the package self-contained.
 */

/** Persistence backend for OAuth connections (PostgREST-style call shapes). */
export interface ConnectionStore {
  /** Insert a row into `table`. */
  insert(table: string, row: Record<string, unknown>): Promise<{ ok: boolean }>;
  /** Patch rows in `table` matching a `key=eq.value[&…]` filter string. */
  patch(table: string, filter: string, data: Record<string, unknown>): Promise<{ ok: boolean }>;
  /** Select rows from `table` matching a `key=eq.value[&…&order=col.dir&limit=n]` query string. */
  get(table: string, query: string): Promise<Record<string, unknown>[] | null>;
}

interface ParsedQuery {
  filters: Array<[column: string, value: string]>;
  order?: { column: string; desc: boolean };
  limit?: number;
}

/** Parse the subset of PostgREST query syntax used by OAuthManager. */
function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { filters: [] };
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "order") {
      const [column, direction] = value.split(".");
      parsed.order = { column: column ?? "", desc: direction === "desc" };
    } else if (key === "limit") {
      const n = Number(value);
      if (Number.isFinite(n)) parsed.limit = n;
    } else if (value.startsWith("eq.")) {
      parsed.filters.push([key, decodeURIComponent(value.slice(3))]);
    }
  }
  return parsed;
}

function matches(row: Record<string, unknown>, filters: ParsedQuery["filters"]): boolean {
  return filters.every(([column, value]) => String(row[column]) === value);
}

/** In-memory ConnectionStore (default; suitable for tests and single-process use). */
export class InMemoryConnectionStore implements ConnectionStore {
  private readonly tables = new Map<string, Record<string, unknown>[]>();

  async insert(table: string, row: Record<string, unknown>): Promise<{ ok: boolean }> {
    const rows = this.tables.get(table) ?? [];
    rows.push({ ...row });
    this.tables.set(table, rows);
    return { ok: true };
  }

  async patch(table: string, filter: string, data: Record<string, unknown>): Promise<{ ok: boolean }> {
    const { filters } = parseQuery(filter);
    let matched = false;
    for (const row of this.tables.get(table) ?? []) {
      if (matches(row, filters)) {
        Object.assign(row, data);
        matched = true;
      }
    }
    return { ok: matched };
  }

  async get(table: string, query: string): Promise<Record<string, unknown>[] | null> {
    const { filters, order, limit } = parseQuery(query);
    let rows = (this.tables.get(table) ?? []).filter((row) => matches(row, filters));
    if (order) {
      const { column, desc } = order;
      rows = [...rows].sort((a, b) => {
        const av = String(a[column] ?? "");
        const bv = String(b[column] ?? "");
        return desc ? bv.localeCompare(av) : av.localeCompare(bv);
      });
    }
    if (limit !== undefined) rows = rows.slice(0, limit);
    return rows.map((row) => ({ ...row }));
  }
}
