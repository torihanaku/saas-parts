/**
 * Persistence interface for the skills service.
 * Collapses the original cockpit_project_sources (source_type='skill') REST calls.
 */
import type { SkillRow } from "./types";

export interface SkillStore {
  list(clientId?: string): Promise<SkillRow[]>;
  get(id: string): Promise<SkillRow | null>;
  insert(row: SkillRow): Promise<void>;
  patch(id: string, patch: Partial<SkillRow>): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  /** Fetch arbitrary source rows for the generate step (source materials). */
  getSourceMaterials(ids: string[]): Promise<{ name: string; content: string }[]>;
}

export class InMemorySkillStore implements SkillStore {
  rows = new Map<string, SkillRow>();
  /** Raw source materials keyed by id (for the generate step). */
  materials = new Map<string, { name: string; content: string }>();

  async list(clientId?: string): Promise<SkillRow[]> {
    return [...this.rows.values()]
      .filter((r) => (clientId ? r.client_id === clientId : true))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async get(id: string): Promise<SkillRow | null> {
    return this.rows.get(id) ?? null;
  }

  async insert(row: SkillRow): Promise<void> {
    this.rows.set(row.id, row);
  }

  async patch(id: string, patch: Partial<SkillRow>): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r) return false;
    this.rows.set(id, { ...r, ...patch });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async getSourceMaterials(ids: string[]): Promise<{ name: string; content: string }[]> {
    const out: { name: string; content: string }[] = [];
    for (const id of ids) {
      const m = this.materials.get(id);
      if (m) out.push(m);
    }
    return out;
  }
}
