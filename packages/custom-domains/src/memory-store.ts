/**
 * In-memory {@link DomainStore} — reference implementation for tests, local
 * dev and as a template for real adapters (Supabase / Firestore / SQL).
 */

import type { DomainRecord, DomainState, DomainStore, DomainUpdatePatch } from "./types";

export interface MemoryDomainStore extends DomainStore {
  seed(records: DomainRecord[]): void;
  get(id: string): DomainRecord | undefined;
  all(): DomainRecord[];
}

export function createMemoryDomainStore(initial: DomainRecord[] = []): MemoryDomainStore {
  const records = new Map<string, DomainRecord>(initial.map((r) => [r.id, { ...r }]));
  return {
    async listByState(state: DomainState): Promise<DomainRecord[]> {
      return [...records.values()].filter((r) => r.state === state);
    },
    async update(id: string, patch: DomainUpdatePatch): Promise<void> {
      const existing = records.get(id);
      if (!existing) throw new Error(`domain record not found: ${id}`);
      records.set(id, { ...existing, ...patch });
    },
    seed(rows: DomainRecord[]): void {
      for (const r of rows) records.set(r.id, { ...r });
    },
    get(id: string): DomainRecord | undefined {
      return records.get(id);
    },
    all(): DomainRecord[] {
      return [...records.values()];
    },
  };
}
