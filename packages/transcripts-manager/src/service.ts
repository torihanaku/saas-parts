/**
 * Transcripts manager — transcript record management, lifecycle status
 * transitions, audio metadata management, structured extraction, action-item
 * extraction, meeting-notes generation, and search.
 *
 * Ported from 実運用SaaS `server/routes/transcripts/{index,crud,audio,actions}.ts`.
 *
 * ── Boundary note ──
 * The actual speech-to-text (Whisper) API belongs to @torihanaku/transcribe-client.
 * This package does NOT import it; instead it accepts an injected
 * {@link TranscriptionClient}. The LLM structuring / notes / action extraction
 * are likewise injected. HTTP/auth/BYOK-key-resolution stay in the host.
 */
import type { TranscriptStore } from "./store";
import {
  buildStructuringPrompt,
  parseStructuredResponse,
  isAllowedAudio,
  MAX_AUDIO_SIZE,
  type ExtractedActionItem,
  type StructuredTranscript,
  type TranscriptRecord,
  type TranscriptSearchItem,
  type TranscriptStatus,
} from "./types";

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

function fail(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}
function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

/** Speech-to-text, injected (belongs to @torihanaku/transcribe-client). */
export type TranscriptionClient = (input: {
  storagePath: string;
  mimeType: string;
  filename: string;
}) => Promise<{ text: string }>;

/** Raw LLM call for structuring — receives a prompt, returns text. */
export type TranscriptLLM = (prompt: string) => Promise<{ text: string }>;

/** Action item extractor (injected; original was content-engine.extractActionItems). */
export type ActionExtractor = (text: string) => Promise<ExtractedActionItem[]>;

/** Meeting-notes generator (injected; original was content-engine.generateContent). */
export type NotesGenerator = (input: {
  topic: string;
  extraContext: string;
}) => Promise<{ content: string }>;

/** Optional sinks for extracted artifacts (backlog / notes drafts). */
export interface TranscriptSinks {
  /** Persist backlog items; returns saved count. */
  saveBacklogItems?(items: BacklogItem[]): Promise<number>;
  /** Persist a notes draft. */
  saveNotesDraft?(draft: NotesDraft): Promise<void>;
}

export interface BacklogItem {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  source: string;
  source_id: string;
  due_date: string | null;
  created_at: string;
}

export interface NotesDraft {
  id: string;
  title: string;
  content: string;
  type: string;
  status: string;
  source: string;
  source_id: string;
  created_at: string;
}

export interface TranscriptServiceOptions {
  store: TranscriptStore;
  transcribe?: TranscriptionClient;
  llm?: TranscriptLLM;
  extractActions?: ActionExtractor;
  generateNotes?: NotesGenerator;
  sinks?: TranscriptSinks;
  uuid?: () => string;
  now?: () => Date;
}

export class TranscriptService {
  private store: TranscriptStore;
  private transcribe?: TranscriptionClient;
  private llm?: TranscriptLLM;
  private extractActions?: ActionExtractor;
  private generateNotes?: NotesGenerator;
  private sinks: TranscriptSinks;
  private uuid: () => string;
  private now: () => Date;

  constructor(opts: TranscriptServiceOptions) {
    this.store = opts.store;
    this.transcribe = opts.transcribe;
    this.llm = opts.llm;
    this.extractActions = opts.extractActions;
    this.generateNotes = opts.generateNotes;
    this.sinks = opts.sinks ?? {};
    this.uuid = opts.uuid ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => new Date());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  async list(projectId: string): Promise<ServiceResult<TranscriptRecord[]>> {
    return ok(await this.store.listByProject(projectId));
  }

  async create(
    projectId: string,
    body: Partial<TranscriptRecord> & { title?: string; user_id?: string },
  ): Promise<ServiceResult<TranscriptRecord>> {
    if (!body.title) return fail(400, "title is required");
    const nowIso = this.iso();
    const transcript: TranscriptRecord = {
      id: body.id || this.uuid(),
      project_id: projectId,
      user_id: body.user_id || "system",
      title: body.title,
      audio_filename: body.audio_filename ?? null,
      audio_size_bytes: body.audio_size_bytes ?? null,
      audio_duration_seconds: body.audio_duration_seconds ?? null,
      audio_mime_type: body.audio_mime_type ?? null,
      raw_transcript: body.raw_transcript ?? null,
      summary: body.summary ?? null,
      decisions: body.decisions || [],
      action_items: body.action_items || [],
      key_points: body.key_points || [],
      participants: body.participants || [],
      status: body.status || "pending",
      error_message: null,
      metadata: body.metadata || {},
      created_at: nowIso,
      updated_at: nowIso,
    };
    await this.store.insert(transcript);
    return ok(transcript);
  }

  async get(id: string): Promise<ServiceResult<TranscriptRecord>> {
    const row = await this.store.get(id);
    if (!row) return fail(404, "Transcript not found");
    return ok(row);
  }

  async update(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<ServiceResult<{ ok: true; id: string }>> {
    const done = await this.store.patch(id, { ...patch, updated_at: this.iso() });
    if (!done) return fail(404, "Transcript not found");
    return ok({ ok: true, id });
  }

  async delete(id: string): Promise<ServiceResult<{ ok: true; id: string }>> {
    await this.store.delete(id);
    return ok({ ok: true, id });
  }

  async search(q: string, projectId?: string): Promise<ServiceResult<TranscriptSearchItem[]>> {
    if (!q) return fail(400, "Query parameter 'q' is required");
    return ok(await this.store.search(q, projectId));
  }

  // ─── Audio metadata management ────────────────────────────────────────────────

  /**
   * Validates + records audio metadata after a successful storage upload.
   * Storage upload itself is the host's job (Supabase Storage in the original);
   * pass the resolved storagePath. Sets status → transcribing.
   */
  async attachAudio(
    id: string,
    audio: { filename: string; sizeBytes: number; mimeType: string; storagePath: string },
  ): Promise<ServiceResult<{ ok: true; id: string; filename: string; size_bytes: number; mime_type: string; status: TranscriptStatus }>> {
    if (audio.sizeBytes > MAX_AUDIO_SIZE) {
      return fail(413, "ファイルサイズが上限（50MB）を超えています");
    }
    if (!isAllowedAudio(audio.filename, audio.mimeType)) {
      return fail(400, "無効なファイル形式です。MP3, WAV, M4A, WEBMのみ対応しています");
    }
    const existing = await this.store.get(id);
    if (!existing) return fail(404, "Transcript not found");

    const mime = audio.mimeType || "audio/webm";
    const done = await this.store.patch(id, {
      audio_filename: audio.filename,
      audio_size_bytes: audio.sizeBytes,
      audio_mime_type: mime,
      status: "transcribing",
      metadata: { ...existing.metadata, storage_path: audio.storagePath },
      updated_at: this.iso(),
    });
    if (!done) return fail(500, "Failed to store audio");
    return ok({
      ok: true,
      id,
      filename: audio.filename,
      size_bytes: audio.sizeBytes,
      mime_type: mime,
      status: "transcribing",
    });
  }

  // ─── Transcription (delegates to injected TranscriptionClient) ──────────────────

  async runTranscription(
    id: string,
  ): Promise<ServiceResult<{ ok: true; id: string; status: TranscriptStatus; raw_transcript: string }>> {
    const t = await this.store.get(id);
    if (!t) return fail(404, "Transcript not found");
    const storagePath = (t.metadata as { storage_path?: string })?.storage_path;
    if (!storagePath) return fail(400, "No audio data found. Upload audio first.");
    if (!this.transcribe) {
      return fail(
        501,
        "Transcription client is not configured. Inject a TranscriptionClient (@torihanaku/transcribe-client).",
      );
    }
    try {
      const { text } = await this.transcribe({
        storagePath,
        mimeType: t.audio_mime_type || "audio/webm",
        filename: t.audio_filename || "audio.webm",
      });
      await this.store.patch(id, {
        raw_transcript: text,
        status: "structuring",
        updated_at: this.iso(),
      });
      return ok({ ok: true, id, status: "structuring", raw_transcript: text });
    } catch (e) {
      await this.store
        .patch(id, {
          status: "error",
          error_message: e instanceof Error ? e.message : "Unknown transcription error",
          updated_at: this.iso(),
        })
        .catch(() => {});
      return fail(500, "Transcription failed");
    }
  }

  // ─── Structuring (LLM injected) ────────────────────────────────────────────────

  async structure(
    id: string,
  ): Promise<ServiceResult<{ ok: true; id: string; status: TranscriptStatus } & StructuredTranscript>> {
    const t = await this.store.get(id);
    if (!t) return fail(404, "Transcript not found");
    if (!t.raw_transcript) return fail(400, "No raw transcript found. Run transcription first.");
    if (!this.llm) {
      return fail(501, "ANTHROPIC_API_KEY is not configured. Inject a TranscriptLLM.");
    }
    try {
      const { text } = await this.llm(buildStructuringPrompt(t.raw_transcript));
      const structured = parseStructuredResponse(text);
      await this.store.patch(id, {
        summary: structured.summary || null,
        decisions: structured.decisions || [],
        action_items: structured.action_items || [],
        key_points: structured.key_points || [],
        participants: structured.participants || [],
        status: "completed",
        updated_at: this.iso(),
      });
      return ok({ ok: true, id, status: "completed", ...structured });
    } catch (e) {
      await this.store
        .patch(id, {
          status: "error",
          error_message: e instanceof Error ? e.message : "Unknown structuring error",
          updated_at: this.iso(),
        })
        .catch(() => {});
      return fail(500, "Structuring failed");
    }
  }

  // ─── Action item extraction ─────────────────────────────────────────────────────

  async extractActionItems(
    id: string,
  ): Promise<ServiceResult<{ items: ExtractedActionItem[]; savedCount: number; transcriptId: string }>> {
    const t = await this.store.get(id);
    if (!t) return fail(404, "Transcript not found");
    const text = t.raw_transcript || t.summary || "";
    if (!text) return fail(400, "トランスクリプトテキストがありません");
    if (!this.extractActions) {
      return fail(500, "ANTHROPIC_API_KEY not set (ActionExtractor not injected)");
    }

    const items = await this.extractActions(text);
    const nowIso = this.iso();
    const backlogItems: BacklogItem[] = items.map((item) => ({
      id: this.uuid(),
      title: item.title,
      description: `出典: 議事録「${t.title}」\n担当: ${item.owner || "未定"}`,
      status: "pending",
      priority: item.priority === "high" ? "P1-High" : item.priority === "low" ? "P3-Low" : "P2-Medium",
      source: "transcript",
      source_id: id,
      due_date: item.due_date || null,
      created_at: nowIso,
    }));

    const savedCount = this.sinks.saveBacklogItems
      ? await this.sinks.saveBacklogItems(backlogItems)
      : 0;

    await this.store.patch(id, {
      metadata: { ...t.metadata, action_items_extracted_at: nowIso },
      updated_at: nowIso,
    });

    return ok({ items, savedCount, transcriptId: id });
  }

  // ─── Meeting notes generation ────────────────────────────────────────────────────

  async generateMeetingNotes(
    id: string,
  ): Promise<ServiceResult<{ draft: NotesDraft; transcriptId: string }>> {
    const t = await this.store.get(id);
    if (!t) return fail(404, "Transcript not found");
    if (!this.generateNotes) {
      return fail(500, "ANTHROPIC_API_KEY not set (NotesGenerator not injected)");
    }

    const { content } = await this.generateNotes({
      topic: t.title || "ミーティング",
      extraContext: t.raw_transcript || t.summary || "",
    });

    const draft: NotesDraft = {
      id: this.uuid(),
      title: `議事録: ${t.title || "ミーティング"}`,
      content,
      type: "meeting-notes",
      status: "draft",
      source: "transcript",
      source_id: id,
      created_at: this.iso(),
    };
    if (this.sinks.saveNotesDraft) await this.sinks.saveNotesDraft(draft);

    await this.store.patch(id, {
      metadata: { ...t.metadata, notes_draft_id: draft.id },
      updated_at: this.iso(),
    });

    return ok({ draft, transcriptId: id });
  }
}
