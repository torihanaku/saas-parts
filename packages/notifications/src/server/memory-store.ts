/**
 * In-memory reference implementation of {@link NotificationStore}.
 * Mirrors the semantics the original Supabase table gave the routes:
 * list = filtered by status, ordered by created_at desc, limited;
 * update on an unknown id succeeds as a no-op (PostgREST PATCH matching
 * zero rows still returns 2xx).
 */
import type {
  DashboardNotification,
  NotificationStatusFilter,
  NotificationStore,
  StoreResult,
} from "./types";

export interface InMemoryNotificationStore extends NotificationStore {
  /** All records, including soft-deleted ones (audit trail). */
  dump(): DashboardNotification[];
  /** Reset the store. */
  clear(): void;
}

export function createInMemoryNotificationStore(
  seed: DashboardNotification[] = []
): InMemoryNotificationStore {
  let records: DashboardNotification[] = [...seed];

  return {
    async list(options: {
      status: NotificationStatusFilter;
      limit: number;
    }): Promise<DashboardNotification[]> {
      const filtered = options.status === "all"
        ? records.filter((r) => r.status !== "deleted")
        : records.filter((r) => r.status === options.status);
      return filtered
        .slice()
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
        .slice(0, options.limit);
    },

    async countPending(): Promise<number> {
      return records.filter((r) => r.status === "pending").length;
    },

    async insert(record: DashboardNotification): Promise<StoreResult> {
      if (records.some((r) => r.id === record.id)) {
        return { ok: false, error: "duplicate id" };
      }
      records.push({ ...record });
      return { ok: true };
    },

    async update(
      id: string,
      patch: Partial<Pick<DashboardNotification, "status" | "read_at">>
    ): Promise<StoreResult> {
      records = records.map((r) => (r.id === id ? { ...r, ...patch } : r));
      return { ok: true };
    },

    dump(): DashboardNotification[] {
      return records.map((r) => ({ ...r }));
    },

    clear(): void {
      records = [];
    },
  };
}
