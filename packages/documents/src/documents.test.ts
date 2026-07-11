import { describe, it, expect, beforeEach, vi } from "vitest";
import { DocumentService, type DocumentLLM } from "./service";
import { InMemoryDocumentStore } from "./store";
import {
  BUILTIN_TEMPLATES,
  buildContextString,
  markdownToHtml,
  type ProjectContext,
} from "./types";

function makeService(store = new InMemoryDocumentStore(), llm?: DocumentLLM) {
  let n = 0;
  const svc = new DocumentService({
    store,
    llm,
    uuid: () => {
      n += 1;
      return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    },
    now: () => new Date("2026-07-11T00:00:00Z"),
  });
  return { svc, store };
}

describe("templates", () => {
  it("seeds builtins on first empty list", async () => {
    const { svc, store } = makeService();
    const r = await svc.listTemplates();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.length).toBe(BUILTIN_TEMPLATES.length);
    expect(store.templates.size).toBe(BUILTIN_TEMPLATES.length);
  });

  it("does not re-seed when templates exist", async () => {
    const { svc } = makeService();
    await svc.listTemplates();
    const again = await svc.listTemplates();
    expect(again.ok && again.data.length).toBe(BUILTIN_TEMPLATES.length);
  });

  it("orders builtins first, then by name", async () => {
    const { svc } = makeService();
    const r = await svc.listTemplates();
    if (r.ok) expect(r.data.every((t) => t.is_builtin)).toBe(true);
  });

  it("createTemplate validates name + prompt_template", async () => {
    const { svc } = makeService();
    expect((await svc.createTemplate({ prompt_template: "x" })).ok).toBe(false);
    expect((await svc.createTemplate({ name: "x" })).ok).toBe(false);
    const ok = await svc.createTemplate({ name: "Custom", prompt_template: "{{context}}" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.is_builtin).toBe(false);
  });
});

describe("document CRUD + versioning", () => {
  let svc: DocumentService;
  let store: InMemoryDocumentStore;
  beforeEach(() => ({ svc, store } = makeService()));

  it("creates a document with defaults", async () => {
    const r = await svc.createDocument("proj-1", { title: "Spec" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.version).toBe(1);
      expect(r.data.template_type).toBe("requirements");
      expect(r.data.status).toBe("draft");
    }
  });

  it("requires title", async () => {
    const r = await svc.createDocument("proj-1", {});
    expect(r.ok).toBe(false);
  });

  it("lists documents ordered by updated_at desc (projection only)", async () => {
    await svc.createDocument("proj-1", { title: "A" });
    const r = await svc.listDocuments("proj-1");
    expect(r.ok && r.data.length).toBe(1);
    if (r.ok) expect(Object.keys(r.data[0]!)).not.toContain("content_markdown");
  });

  it("get / update / delete round-trip", async () => {
    const c = await svc.createDocument("proj-1", { title: "A" });
    const id = c.ok ? c.data.id : "";
    expect((await svc.getDocument(id)).ok).toBe(true);
    const upd = await svc.updateDocument(id, { status: "final" });
    expect(upd.ok && upd.data.status).toBe("final");
    expect((await svc.deleteDocument(id)).ok).toBe(true);
    expect((await svc.getDocument(id)).ok).toBe(false);
  });

  it("update on missing doc → 404", async () => {
    const r = await svc.updateDocument("missing", { status: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("newVersion increments version + links parent", async () => {
    const c = await svc.createDocument("proj-1", { title: "A" });
    const id = c.ok ? c.data.id : "";
    const v2 = await svc.newVersion(id);
    expect(v2.ok).toBe(true);
    if (v2.ok) {
      expect(v2.data.version).toBe(2);
      expect(v2.data.parent_id).toBe(id);
      expect(v2.data.id).not.toBe(id);
    }
  });
});

describe("comments", () => {
  it("creates + lists unresolved comments, validates length", async () => {
    const { svc } = makeService();
    const c = await svc.createDocument("p", { title: "A" });
    const docId = c.ok ? c.data.id : "";
    expect((await svc.createComment(docId, "me@x.co", { body: "" })).ok).toBe(false);
    expect((await svc.createComment(docId, "me@x.co", { body: "x".repeat(2001) })).ok).toBe(false);
    const ok = await svc.createComment(docId, "me@x.co", { body: "looks good", author_name: "Bob" });
    expect(ok.ok).toBe(true);
    const list = await svc.listComments(docId);
    expect(list.ok && list.data.length).toBe(1);
  });
});

describe("AI generation", () => {
  const contextProvider = (): ProjectContext => ({
    project: { name: "Proj", description: "desc", background_notes: "bg", client_id: "c1" },
    client: { name: "Acme", industry: "SaaS", description: "cd" },
    transcripts: [{ title: "Kickoff", summary: "s", created_at: "2026-01-01" }],
    slack_messages: [{ channel_name: "gen", user_name: "u", text: "hi" }],
    sources: [{ title: "spec", source_type: "doc", content_preview: "p" }],
    assembled_at: "2026-07-11T00:00:00Z",
  });

  it("uses injected LLM, patches the doc, returns summary counts", async () => {
    const store = new InMemoryDocumentStore(contextProvider);
    const llm = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("要件定義書"); // builtin template applied
      expect(prompt).toContain("Proj");
      return { text: "# Result\n\n**bold**", model: "test-model" };
    });
    const { svc } = makeService(store, llm);
    const c = await svc.createDocument("proj-1", { title: "Spec", template_type: "requirements" });
    const id = c.ok ? c.data.id : "";
    const r = await svc.generate(id, { additional_instructions: "be concise" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.model_used).toBe("test-model");
      expect(r.data.content_html).toContain("<h1>Result</h1>");
      expect(r.data.content_html).toContain("<strong>bold</strong>");
      expect(r.data.context_summary).toEqual({
        transcript_count: 1,
        slack_message_count: 1,
        source_count: 1,
      });
    }
    const stored = await store.getDocument(id);
    expect(stored!.content_markdown).toContain("# Result");
    expect(llm).toHaveBeenCalledOnce();
  });

  it("falls back to placeholder when no LLM injected", async () => {
    const { svc } = makeService();
    const c = await svc.createDocument("proj-1", { title: "Spec" });
    const id = c.ok ? c.data.id : "";
    const r = await svc.generate(id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.model_used).toBe("none (no API key)");
      expect(r.data.content_markdown).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("404 when document missing", async () => {
    const { svc } = makeService();
    const r = await svc.generate("missing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("uses stored template over builtin when present", async () => {
    const store = new InMemoryDocumentStore(contextProvider);
    await store.insertTemplate({
      id: "t1",
      user_id: "u",
      name: "Custom Req",
      template_type: "requirements",
      description: "",
      prompt_template: "CUSTOM_MARKER {{context}}",
      output_format: "markdown",
      is_builtin: false,
      metadata: {},
      created_at: "x",
      updated_at: "x",
    });
    const llm = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("CUSTOM_MARKER");
      return { text: "ok", model: "m" };
    });
    const { svc } = makeService(store, llm);
    const c = await svc.createDocument("p", { title: "T", template_type: "requirements" });
    await svc.generate(c.ok ? c.data.id : "");
    expect(llm).toHaveBeenCalledOnce();
  });
});

describe("helpers", () => {
  it("markdownToHtml handles headings, bold, lists", () => {
    const html = markdownToHtml("# Title\n\n- one\n- two\n\n**b**");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<strong>b</strong>");
  });
  it("markdownToHtml empty → empty", () => expect(markdownToHtml("")).toBe(""));

  it("buildContextString includes project + client + sections", () => {
    const s = buildContextString({
      project: { name: "P", description: "d", background_notes: "bg", client_id: null },
      client: { name: "C", industry: "I", description: "cd" },
      transcripts: [{ title: "T", summary: "sum", decisions: ["d1"], action_items: ["a1"] }],
      slack_messages: [{ channel_name: "ch", user_name: "u", text: "hi" }],
      sources: [{ title: "src", source_type: "doc", content_preview: "prev" }],
      assembled_at: "x",
    });
    expect(s).toContain("## プロジェクト: P");
    expect(s).toContain("## クライアント: C");
    expect(s).toContain("決定事項:");
    expect(s).toContain("Slack会話");
    expect(s).toContain("追加ソース");
  });
});
