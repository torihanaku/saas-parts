/**
 * Documents service — template + document CRUD, versioning, comments, and
 * AI content generation from a template + assembled project context.
 *
 * Ported from 実運用SaaS `server/routes/documents/{crud,generate,shared}.ts`.
 * The Anthropic REST call is replaced by an injected {@link DocumentLLM}; when
 * omitted (or returning null), the original "no API key" placeholder path runs.
 */
import type { DocumentStore } from "./store";
import {
  BUILTIN_TEMPLATES,
  buildContextString,
  markdownToHtml,
  type DocumentComment,
  type DocumentListItem,
  type DocumentRecord,
  type DocumentTemplate,
  type ProjectContext,
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

/**
 * Injected LLM. Receives the fully-assembled prompt, returns the generated
 * markdown + model id. Return null (or omit the LLM) to run the placeholder
 * path that mirrors the original "ANTHROPIC_API_KEY not set" behaviour.
 */
export type DocumentLLM = (prompt: string) => Promise<{ text: string; model: string } | null>;

export interface DocumentServiceOptions {
  store: DocumentStore;
  llm?: DocumentLLM;
  uuid?: () => string;
  now?: () => Date;
}

export interface GenerateInput {
  source_ids?: string[];
  additional_instructions?: string;
}

export class DocumentService {
  private store: DocumentStore;
  private llm?: DocumentLLM;
  private uuid: () => string;
  private now: () => Date;

  constructor(opts: DocumentServiceOptions) {
    this.store = opts.store;
    this.llm = opts.llm;
    this.uuid = opts.uuid ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => new Date());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ─── Templates ──────────────────────────────────────────────────────────────

  /** List templates; seeds builtins on first empty read (mirrors original). */
  async listTemplates(): Promise<ServiceResult<DocumentTemplate[]>> {
    const rows = await this.store.listTemplates();
    if (rows.length > 0) return ok(rows);
    const nowIso = this.iso();
    for (const tmpl of BUILTIN_TEMPLATES) {
      await this.store.insertTemplate({
        id: this.uuid(),
        user_id: "system",
        output_format: "markdown",
        metadata: {},
        created_at: nowIso,
        updated_at: nowIso,
        ...tmpl,
      });
    }
    return ok(await this.store.listTemplates());
  }

  async createTemplate(body: {
    user_id?: string;
    name?: string;
    template_type?: string;
    description?: string;
    prompt_template?: string;
    output_format?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ServiceResult<DocumentTemplate>> {
    const nowIso = this.iso();
    const template: DocumentTemplate = {
      id: this.uuid(),
      user_id: body.user_id || "unknown",
      name: body.name ?? "",
      template_type: body.template_type || "custom",
      description: body.description || "",
      prompt_template: body.prompt_template ?? "",
      output_format: body.output_format || "markdown",
      is_builtin: false,
      metadata: body.metadata || {},
      created_at: nowIso,
      updated_at: nowIso,
    };
    if (!template.name) return fail(400, "name is required");
    if (!template.prompt_template) return fail(400, "prompt_template is required");
    await this.store.insertTemplate(template);
    return ok(template);
  }

  // ─── Documents CRUD ─────────────────────────────────────────────────────────

  async listDocuments(projectId: string): Promise<ServiceResult<DocumentListItem[]>> {
    return ok(await this.store.listDocuments(projectId));
  }

  async getDocument(id: string): Promise<ServiceResult<DocumentRecord>> {
    const doc = await this.store.getDocument(id);
    if (!doc) return fail(404, "Document not found");
    return ok(doc);
  }

  async createDocument(
    projectId: string,
    body: Partial<DocumentRecord> & { title?: string; template_type?: string; user_id?: string },
  ): Promise<ServiceResult<DocumentRecord>> {
    const nowIso = this.iso();
    const doc: DocumentRecord = {
      id: this.uuid(),
      project_id: projectId,
      user_id: body.user_id || "unknown",
      title: body.title ?? "",
      template_type: body.template_type || "requirements",
      content_markdown: body.content_markdown ?? null,
      content_html: body.content_html ?? null,
      source_ids: body.source_ids || [],
      context_snapshot: body.context_snapshot || {},
      prompt_used: body.prompt_used ?? null,
      model_used: body.model_used ?? null,
      version: 1,
      parent_id: null,
      status: body.status || "draft",
      metadata: body.metadata || {},
      created_at: nowIso,
      updated_at: nowIso,
    };
    if (!doc.title) return fail(400, "title is required");
    if (!doc.template_type) return fail(400, "template_type is required");
    await this.store.insertDocument(doc);
    return ok(doc);
  }

  async updateDocument(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<ServiceResult<DocumentRecord>> {
    const updated = { ...patch, updated_at: this.iso() } as Partial<DocumentRecord>;
    const done = await this.store.patchDocument(id, updated);
    if (!done) return fail(404, "Document not found after update");
    const doc = await this.store.getDocument(id);
    if (!doc) return fail(404, "Document not found after update");
    return ok(doc);
  }

  async deleteDocument(id: string): Promise<ServiceResult<{ ok: true; id: string }>> {
    await this.store.deleteDocument(id);
    return ok({ ok: true, id });
  }

  /** Create a new version (increments version, links parent_id). */
  async newVersion(id: string): Promise<ServiceResult<DocumentRecord>> {
    const current = await this.store.getDocument(id);
    if (!current) return fail(404, "Document not found");
    const nowIso = this.iso();
    const newDoc: DocumentRecord = {
      ...current,
      id: this.uuid(),
      source_ids: current.source_ids || [],
      context_snapshot: current.context_snapshot || {},
      version: (current.version || 1) + 1,
      parent_id: current.id,
      status: "draft",
      metadata: current.metadata || {},
      created_at: nowIso,
      updated_at: nowIso,
    };
    await this.store.insertDocument(newDoc);
    return ok(newDoc);
  }

  // ─── Comments ───────────────────────────────────────────────────────────────

  async listComments(documentId: string): Promise<ServiceResult<DocumentComment[]>> {
    return ok(await this.store.listComments(documentId));
  }

  async createComment(
    documentId: string,
    authorEmail: string,
    body: { author_name?: string; body?: string; anchor?: Record<string, unknown> },
  ): Promise<ServiceResult<DocumentComment>> {
    const commentBody = typeof body.body === "string" ? body.body.trim() : "";
    if (!commentBody) return fail(400, "body is required");
    if (commentBody.length > 2000) return fail(400, "body must be 2000 characters or less");

    const nowIso = this.iso();
    const comment: DocumentComment = {
      id: this.uuid(),
      document_id: documentId,
      author_email: authorEmail,
      author_name: (typeof body.author_name === "string" && body.author_name.trim()
        ? body.author_name.trim()
        : "Editor"
      ).slice(0, 120),
      body: commentBody,
      anchor: body.anchor && typeof body.anchor === "object" ? body.anchor : {},
      resolved_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    const inserted = await this.store.insertComment(comment);
    if (!inserted) return fail(502, "Failed to create document comment");
    return ok(inserted);
  }

  // ─── AI generation ──────────────────────────────────────────────────────────

  async generate(
    docId: string,
    input: GenerateInput = {},
  ): Promise<
    ServiceResult<{
      ok: true;
      id: string;
      title: string;
      content_markdown: string;
      content_html: string;
      model_used: string;
      context_summary: { transcript_count: number; slack_message_count: number; source_count: number };
    }>
  > {
    const doc = await this.store.getDocument(docId);
    if (!doc) return fail(404, "Document not found");

    // Resolve prompt template (stored → builtin → generic fallback).
    const tmpl = await this.store.getTemplateByType(doc.template_type);
    let promptTemplate = "";
    if (tmpl) {
      promptTemplate = tmpl.prompt_template;
    } else {
      const builtin = BUILTIN_TEMPLATES.find((t) => t.template_type === doc.template_type);
      promptTemplate = builtin
        ? builtin.prompt_template
        : "プロジェクト文脈を踏まえて、ドキュメントを作成してください:\n\n{{context}}";
    }

    const context: ProjectContext = await this.store.assembleProjectContext(doc.project_id);
    const contextString = buildContextString(context);

    const sourceIds = input.source_ids || [];
    const additionalInstructions = input.additional_instructions || "";

    let prompt = promptTemplate.replace("{{context}}", contextString);
    if (additionalInstructions) prompt += `\n\n追加指示:\n${additionalInstructions}`;
    prompt += `\n\nドキュメントタイトル: ${doc.title}`;

    let contentMarkdown = "";
    let modelUsed = "";

    const llmResult = this.llm ? await this.llm(prompt) : null;
    if (llmResult) {
      contentMarkdown = llmResult.text;
      modelUsed = llmResult.model;
    } else {
      contentMarkdown = `# ${doc.title}\n\n> ANTHROPIC_API_KEY が設定されていないため、AI生成をスキップしました。\n> 環境変数に API キーを設定してから再実行してください。\n\n## プロンプト\n\n${prompt}`;
      modelUsed = "none (no API key)";
    }

    const contentHtml = markdownToHtml(contentMarkdown);

    await this.store.patchDocument(docId, {
      content_markdown: contentMarkdown,
      content_html: contentHtml,
      prompt_used: prompt,
      model_used: modelUsed,
      source_ids: sourceIds,
      context_snapshot: context as unknown as Record<string, unknown>,
      status: "draft",
      updated_at: this.iso(),
    });

    return ok({
      ok: true,
      id: docId,
      title: doc.title,
      content_markdown: contentMarkdown,
      content_html: contentHtml,
      model_used: modelUsed,
      context_summary: {
        transcript_count: context.transcripts.length,
        slack_message_count: context.slack_messages.length,
        source_count: context.sources.length,
      },
    });
  }
}
