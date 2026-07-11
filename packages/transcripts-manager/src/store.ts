/**
 * Persistence interface for the transcripts manager.
 * Collapses the original cockpit_transcripts Supabase REST calls.
 */
import type { TranscriptRecord, TranscriptSearchItem } from "./types";

export interface TranscriptStore {
  listByProject(projectId: string): Promise<TranscriptRecord[]>;
  get(id: string): Promise<TranscriptRecord | null>;
  insert(row: TranscriptRecord): Promise<void>;
  patch(id: string, patch: Partial<TranscriptRecord>): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  /** Keyword search over title / raw_transcript / summary (optionally scoped). */
  search(q: string, projectId?: string): Promise<TranscriptSearchItem[]>;
}

export class InMemoryTranscriptStore implements TranscriptStore {
  rows = new Map<string, TranscriptRecord>();

  async listByProject(projectId: string): Promise<TranscriptRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.project_id === projectId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async get(id: string): Promise<TranscriptRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async insert(row: TranscriptRecord): Promise<void> {
    this.rows.set(row.id, row);
  }

  async patch(id: string, patch: Partial<TranscriptRecord>): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r) return false;
    this.rows.set(id, { ...r, ...patch });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async search(q: string, projectId?: string): Promise<TranscriptSearchItem[]> {
    const needle = q.toLowerCase();
    return [...this.rows.values()]
      .filter((r) => {
        if (projectId && r.project_id !== projectId) return false;
        return (
          r.title.toLowerCase().includes(needle) ||
          (r.raw_transcript ?? "").toLowerCase().includes(needle) ||
          (r.summary ?? "").toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(({ id, project_id, user_id, title, summary, status, created_at, updated_at }) => ({
        id,
        project_id,
        user_id,
        title,
        summary,
        status,
        created_at,
        updated_at,
      }));
  }
}
