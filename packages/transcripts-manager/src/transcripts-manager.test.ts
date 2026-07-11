import { describe, it, expect, beforeEach, vi } from "vitest";
import { TranscriptService, type TranscriptServiceOptions } from "./service";
import { InMemoryTranscriptStore } from "./store";
import {
  isAllowedAudio,
  buildStructuringPrompt,
  parseStructuredResponse,
  MAX_AUDIO_SIZE,
} from "./types";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function make(opts: Partial<TranscriptServiceOptions> = {}) {
  const store = new InMemoryTranscriptStore();
  let n = 0;
  const svc = new TranscriptService({
    store,
    uuid: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    },
    now: () => new Date("2026-07-11T00:00:00Z"),
    ...opts,
  });
  return { svc, store };
}

// ─── pure helpers ─────────────────────────────────────────────────────────────

describe("audio validation", () => {
  it("allows known mime types and extensions", () => {
    expect(isAllowedAudio("x.mp3", "")).toBe(true);
    expect(isAllowedAudio("x.dat", "audio/webm")).toBe(true);
    expect(isAllowedAudio("x.txt", "text/plain")).toBe(false);
  });
  it("MAX is 50MB", () => expect(MAX_AUDIO_SIZE).toBe(50 * 1024 * 1024));
});

describe("parseStructuredResponse", () => {
  it("parses fenced json", () => {
    const out = parseStructuredResponse('```json\n{"summary":"s","decisions":[],"action_items":[],"key_points":[],"participants":[]}\n```');
    expect(out.summary).toBe("s");
  });
  it("parses bare json", () => {
    expect(parseStructuredResponse('{"summary":"x"}').summary).toBe("x");
  });
  it("falls back to raw content on invalid json", () => {
    const out = parseStructuredResponse("not json");
    expect(out.summary).toBe("not json");
    expect(out.decisions).toEqual([]);
  });
});

describe("buildStructuringPrompt", () => {
  it("embeds the transcript", () => {
    expect(buildStructuringPrompt("hello world")).toContain("hello world");
  });
});

// ─── CRUD + status ─────────────────────────────────────────────────────────────

describe("CRUD", () => {
  let svc: TranscriptService;
  let store: InMemoryTranscriptStore;
  beforeEach(() => ({ svc, store } = make()));

  it("creates with pending status + defaults", async () => {
    const r = await svc.create(PROJECT, { title: "Meeting" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toBe("pending");
      expect(r.data.decisions).toEqual([]);
    }
  });

  it("requires title", async () => {
    expect((await svc.create(PROJECT, {})).ok).toBe(false);
  });

  it("get / update / delete round trip", async () => {
    const c = await svc.create(PROJECT, { title: "M" });
    const id = c.ok ? c.data.id : "";
    expect((await svc.get(id)).ok).toBe(true);
    expect((await svc.update(id, { title: "M2" })).ok).toBe(true);
    expect((await store.get(id))!.title).toBe("M2");
    expect((await svc.delete(id)).ok).toBe(true);
    expect((await svc.get(id)).ok).toBe(false);
  });

  it("list scoped by project, newest first", async () => {
    await svc.create(PROJECT, { title: "A" });
    const r = await svc.list(PROJECT);
    expect(r.ok && r.data.length).toBe(1);
  });

  it("update on missing → 404", async () => {
    const r = await svc.update("nope", { x: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });
});

describe("search", () => {
  it("requires q and matches title/summary/raw", async () => {
    const { svc } = make();
    expect((await svc.search("")).ok).toBe(false);
    await svc.create(PROJECT, { title: "Budget review", summary: "cost" });
    const hit = await svc.search("budget", PROJECT);
    expect(hit.ok && hit.data.length).toBe(1);
    const miss = await svc.search("xyz");
    expect(miss.ok && miss.data.length).toBe(0);
  });
});

// ─── audio metadata ───────────────────────────────────────────────────────────

describe("attachAudio", () => {
  it("records metadata and moves to transcribing", async () => {
    const { svc, store } = make();
    const c = await svc.create(PROJECT, { title: "M" });
    const id = c.ok ? c.data.id : "";
    const r = await svc.attachAudio(id, {
      filename: "rec.mp3",
      sizeBytes: 1000,
      mimeType: "audio/mpeg",
      storagePath: `${id}.mp3`,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.status).toBe("transcribing");
    const stored = await store.get(id);
    expect((stored!.metadata as { storage_path?: string }).storage_path).toBe(`${id}.mp3`);
  });

  it("rejects oversize", async () => {
    const { svc } = make();
    const c = await svc.create(PROJECT, { title: "M" });
    const id = c.ok ? c.data.id : "";
    const r = await svc.attachAudio(id, {
      filename: "big.mp3",
      sizeBytes: MAX_AUDIO_SIZE + 1,
      mimeType: "audio/mpeg",
      storagePath: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  it("rejects bad format", async () => {
    const { svc } = make();
    const c = await svc.create(PROJECT, { title: "M" });
    const id = c.ok ? c.data.id : "";
    const r = await svc.attachAudio(id, {
      filename: "note.txt",
      sizeBytes: 10,
      mimeType: "text/plain",
      storagePath: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

// ─── transcription (injected client) ────────────────────────────────────────────

describe("runTranscription", () => {
  it("501 when no client injected", async () => {
    const { svc, store } = make();
    const c = await svc.create(PROJECT, { title: "M" });
    const id = c.ok ? c.data.id : "";
    await store.patch(id, { metadata: { storage_path: "x" } });
    const r = await svc.runTranscription(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(501);
  });

  it("400 when no audio uploaded", async () => {
    const transcribe = vi.fn(async () => ({ text: "t" }));
    const { svc } = make({ transcribe });
    const c = await svc.create(PROJECT, { title: "M" });
    const r = await svc.runTranscription(c.ok ? c.data.id : "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("delegates to injected client and moves to structuring", async () => {
    const transcribe = vi.fn(async () => ({ text: "hello transcript" }));
    const { svc, store } = make({ transcribe });
    const c = await svc.create(PROJECT, { title: "M" });
    const id = c.ok ? c.data.id : "";
    await svc.attachAudio(id, { filename: "a.mp3", sizeBytes: 1, mimeType: "audio/mpeg", storagePath: `${id}.mp3` });
    const r = await svc.runTranscription(id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.raw_transcript).toBe("hello transcript");
    expect((await store.get(id))!.status).toBe("structuring");
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it("marks error status when client throws", async () => {
    const transcribe = vi.fn(async () => {
      throw new Error("boom");
    });
    const { svc, store } = make({ transcribe });
    const c = await svc.create(PROJECT, { title: "M" });
    const id = c.ok ? c.data.id : "";
    await svc.attachAudio(id, { filename: "a.mp3", sizeBytes: 1, mimeType: "audio/mpeg", storagePath: "x" });
    const r = await svc.runTranscription(id);
    expect(r.ok).toBe(false);
    expect((await store.get(id))!.status).toBe("error");
  });
});

// ─── structuring (injected LLM) ─────────────────────────────────────────────────

describe("structure", () => {
  it("501 without LLM", async () => {
    const { svc, store } = make();
    const c = await svc.create(PROJECT, { title: "M" });
    const id = c.ok ? c.data.id : "";
    await store.patch(id, { raw_transcript: "hi" });
    const r = await svc.structure(id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(501);
  });

  it("400 without raw transcript", async () => {
    const llm = vi.fn(async () => ({ text: "{}" }));
    const { svc } = make({ llm });
    const c = await svc.create(PROJECT, { title: "M" });
    const r = await svc.structure(c.ok ? c.data.id : "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("parses LLM output, writes fields, completes", async () => {
    const llm = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("会議やミーティング");
      return {
        text: '{"summary":"done","decisions":[{"text":"d"}],"action_items":[],"key_points":[],"participants":[]}',
      };
    });
    const { svc, store } = make({ llm });
    const c = await svc.create(PROJECT, { title: "M" });
    const id = c.ok ? c.data.id : "";
    await store.patch(id, { raw_transcript: "raw text" });
    const r = await svc.structure(id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.summary).toBe("done");
    const stored = await store.get(id);
    expect(stored!.status).toBe("completed");
    expect(stored!.summary).toBe("done");
    expect(stored!.decisions).toEqual([{ text: "d" }]);
  });
});

// ─── action extraction ──────────────────────────────────────────────────────────

describe("extractActionItems", () => {
  it("maps priorities to backlog buckets and calls sink", async () => {
    const extractActions = vi.fn(async () => [
      { title: "Do A", priority: "high" as const, owner: "Ann" },
      { title: "Do B", priority: "low" as const },
      { title: "Do C" },
    ]);
    const saveBacklogItems = vi.fn(async (items: unknown[]) => items.length);
    const { svc, store } = make({ extractActions, sinks: { saveBacklogItems } });
    const c = await svc.create(PROJECT, { title: "Sprint" });
    const id = c.ok ? c.data.id : "";
    await store.patch(id, { raw_transcript: "we agreed to do A, B, C" });
    const r = await svc.extractActionItems(id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.savedCount).toBe(3);
      expect(r.data.items.length).toBe(3);
    }
    const saved = saveBacklogItems.mock.calls[0]![0] as { priority: string }[];
    expect(saved.map((i) => i.priority)).toEqual(["P1-High", "P3-Low", "P2-Medium"]);
    expect((await store.get(id))!.metadata).toHaveProperty("action_items_extracted_at");
  });

  it("400 when no text", async () => {
    const extractActions = vi.fn(async () => []);
    const { svc } = make({ extractActions });
    const c = await svc.create(PROJECT, { title: "Empty" });
    const r = await svc.extractActionItems(c.ok ? c.data.id : "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("500 when extractor not injected", async () => {
    const { svc, store } = make();
    const c = await svc.create(PROJECT, { title: "M" });
    const id = c.ok ? c.data.id : "";
    await store.patch(id, { raw_transcript: "text" });
    const r = await svc.extractActionItems(id);
    expect(r.ok).toBe(false);
  });
});

// ─── notes generation ───────────────────────────────────────────────────────────

describe("generateMeetingNotes", () => {
  it("generates a draft and links it", async () => {
    const generateNotes = vi.fn(async () => ({ content: "# Notes" }));
    const saveNotesDraft = vi.fn(async () => {});
    const { svc, store } = make({ generateNotes, sinks: { saveNotesDraft } });
    const c = await svc.create(PROJECT, { title: "Standup" });
    const id = c.ok ? c.data.id : "";
    await store.patch(id, { raw_transcript: "we discussed X" });
    const r = await svc.generateMeetingNotes(id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.draft.title).toBe("議事録: Standup");
      expect(r.data.draft.content).toBe("# Notes");
    }
    expect(saveNotesDraft).toHaveBeenCalledOnce();
    expect((await store.get(id))!.metadata).toHaveProperty("notes_draft_id");
  });

  it("404 when transcript missing", async () => {
    const generateNotes = vi.fn(async () => ({ content: "x" }));
    const { svc } = make({ generateNotes });
    const r = await svc.generateMeetingNotes("missing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });
});
