/**
 * Persistence interface for the documents service.
 *
 * Collapses the original Supabase REST calls (cockpit_document_templates /
 * cockpit_documents / cockpit_document_comments) into a typed store, plus a
 * project-context provider that stands in for `assembleProjectContext`
 * (which reads cockpit_projects / cockpit_clients / cockpit_transcripts /
 * cockpit_slack_messages / cockpit_project_sources).
 */
import type {
  DocumentComment,
  DocumentListItem,
  DocumentRecord,
  DocumentTemplate,
  ProjectContext,
} from "./types";

export interface DocumentStore {
  // ─ templates ─
  listTemplates(): Promise<DocumentTemplate[]>;
  insertTemplate(t: DocumentTemplate): Promise<void>;
  /** First template matching template_type (limit 1) — used by generate(). */
  getTemplateByType(templateType: string): Promise<DocumentTemplate | null>;

  // ─ documents ─
  listDocuments(projectId: string): Promise<DocumentListItem[]>;
  getDocument(id: string): Promise<DocumentRecord | null>;
  insertDocument(doc: DocumentRecord): Promise<void>;
  patchDocument(id: string, patch: Partial<DocumentRecord>): Promise<boolean>;
  deleteDocument(id: string): Promise<boolean>;

  // ─ comments ─
  listComments(documentId: string): Promise<DocumentComment[]>;
  insertComment(c: DocumentComment): Promise<DocumentComment | null>;

  // ─ context (assembleProjectContext) ─
  assembleProjectContext(projectId: string): Promise<ProjectContext>;
}

// ─── In-memory implementation ────────────────────────────────────────────────

export class InMemoryDocumentStore implements DocumentStore {
  templates = new Map<string, DocumentTemplate>();
  documents = new Map<string, DocumentRecord>();
  comments = new Map<string, DocumentComment>();
  /** Injectable context source (default: empty context). */
  contextProvider: (projectId: string) => Promise<ProjectContext> | ProjectContext;

  constructor(
    contextProvider?: (projectId: string) => Promise<ProjectContext> | ProjectContext,
  ) {
    this.contextProvider =
      contextProvider ??
      ((projectId: string): ProjectContext => ({
        project: { name: projectId, description: "", background_notes: "", client_id: null },
        client: { name: "", industry: "", description: "" },
        transcripts: [],
        slack_messages: [],
        sources: [],
        assembled_at: new Date().toISOString(),
      }));
  }

  async listTemplates(): Promise<DocumentTemplate[]> {
    return [...this.templates.values()].sort((a, b) => {
      if (a.is_builtin !== b.is_builtin) return a.is_builtin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async insertTemplate(t: DocumentTemplate): Promise<void> {
    this.templates.set(t.id, t);
  }

  async getTemplateByType(templateType: string): Promise<DocumentTemplate | null> {
    for (const t of this.templates.values()) {
      if (t.template_type === templateType) return t;
    }
    return null;
  }

  async listDocuments(projectId: string): Promise<DocumentListItem[]> {
    return [...this.documents.values()]
      .filter((d) => d.project_id === projectId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(({ id, title, template_type, version, status, created_at, updated_at }) => ({
        id,
        title,
        template_type,
        version,
        status,
        created_at,
        updated_at,
      }));
  }

  async getDocument(id: string): Promise<DocumentRecord | null> {
    return this.documents.get(id) ?? null;
  }

  async insertDocument(doc: DocumentRecord): Promise<void> {
    this.documents.set(doc.id, doc);
  }

  async patchDocument(id: string, patch: Partial<DocumentRecord>): Promise<boolean> {
    const d = this.documents.get(id);
    if (!d) return false;
    this.documents.set(id, { ...d, ...patch });
    return true;
  }

  async deleteDocument(id: string): Promise<boolean> {
    return this.documents.delete(id);
  }

  async listComments(documentId: string): Promise<DocumentComment[]> {
    return [...this.comments.values()]
      .filter((c) => c.document_id === documentId && c.resolved_at === null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async insertComment(c: DocumentComment): Promise<DocumentComment | null> {
    this.comments.set(c.id, c);
    return c;
  }

  async assembleProjectContext(projectId: string): Promise<ProjectContext> {
    return this.contextProvider(projectId);
  }
}
