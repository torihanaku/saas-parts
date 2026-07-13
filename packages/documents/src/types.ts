/**
 * Document domain types + builtin templates + context helpers.
 * Ported from 実運用SaaS `server/routes/documents/shared.ts` (#230).
 */

export interface DocumentTemplate {
  id: string;
  user_id: string;
  name: string;
  template_type: string;
  description: string;
  prompt_template: string;
  output_format: string;
  is_builtin: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DocumentRecord {
  id: string;
  project_id: string;
  user_id: string;
  title: string;
  template_type: string;
  content_markdown: string | null;
  content_html: string | null;
  source_ids: string[];
  context_snapshot: Record<string, unknown>;
  prompt_used: string | null;
  model_used: string | null;
  version: number;
  parent_id: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Lightweight list projection (matches the original list SELECT). */
export type DocumentListItem = Pick<
  DocumentRecord,
  "id" | "title" | "template_type" | "version" | "status" | "created_at" | "updated_at"
>;

export interface DocumentComment {
  id: string;
  document_id: string;
  author_email: string;
  author_name: string;
  body: string;
  anchor: Record<string, unknown>;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Builtin templates (ported verbatim) ──────────────────────────────────────

export interface BuiltinTemplate {
  name: string;
  template_type: string;
  description: string;
  prompt_template: string;
  is_builtin: true;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  { name: '要件定義書', template_type: 'requirements', description: 'システムやダッシュボードの要件定義', prompt_template: 'プロジェクト文脈を踏まえて、以下の構成で要件定義書を作成してください:\n\n1. 概要\n2. 背景と目的\n3. スコープ\n4. 機能要件\n5. 非機能要件\n6. スケジュール\n7. リスクと対策\n\nプロジェクト文脈:\n{{context}}', is_builtin: true },
  { name: '週次レポート', template_type: 'report', description: '週次の進捗レポート', prompt_template: 'プロジェクト文脈を踏まえて、以下の構成で週次レポートを作成してください:\n\n1. 今週のハイライト\n2. 進捗サマリー\n3. 課題・リスク\n4. 来週の計画\n5. 数値レポート\n\nプロジェクト文脈:\n{{context}}', is_builtin: true },
  { name: '提案書', template_type: 'proposal', description: 'クライアント向け提案書', prompt_template: 'プロジェクト文脈を踏まえて、以下の構成で提案書を作成してください:\n\n1. エグゼクティブサマリー\n2. 現状分析\n3. 提案内容\n4. 期待される効果\n5. スケジュール\n6. 費用見積\n\nプロジェクト文脈:\n{{context}}', is_builtin: true },
  { name: '議事録まとめ', template_type: 'meeting-notes', description: '複数の議事録を統合した要約', prompt_template: 'プロジェクトの複数の議事録を統合して、以下の構成でまとめを作成してください:\n\n1. 全体サマリー\n2. 主要な決定事項\n3. アクションアイテム一覧\n4. 未解決の論点\n5. 次のステップ\n\nプロジェクト文脈:\n{{context}}', is_builtin: true },
];

// ─── Project context (input to AI generation) ─────────────────────────────────

export interface ProjectContext {
  project: { name: string; description: string; background_notes: string; client_id: string | null };
  client: { name: string; industry: string; description: string };
  transcripts: { title?: string; summary?: string; decisions?: unknown[]; action_items?: unknown[]; created_at?: string }[];
  slack_messages: { channel_name?: string; user_name?: string; text?: string; created_at?: string }[];
  sources: { title?: string; source_type?: string; content_preview?: string }[];
  assembled_at: string;
}

// ─── Helpers (ported verbatim) ────────────────────────────────────────────────

export function buildContextString(ctx: ProjectContext): string {
  const parts: string[] = [];

  parts.push(`## プロジェクト: ${ctx.project.name}`);
  if (ctx.project.description) parts.push(ctx.project.description);
  if (ctx.project.background_notes) parts.push(`背景: ${ctx.project.background_notes}`);

  if (ctx.client.name) {
    parts.push(`\n## クライアント: ${ctx.client.name}（${ctx.client.industry || "業界不明"}）`);
    if (ctx.client.description) parts.push(ctx.client.description);
  }

  if (ctx.transcripts.length > 0) {
    parts.push("\n## 議事録");
    for (const t of ctx.transcripts) {
      parts.push(`### ${t.title || "無題"} (${t.created_at || ""})`);
      if (t.summary) parts.push(t.summary);
      if (t.decisions && Array.isArray(t.decisions) && t.decisions.length > 0) {
        parts.push("決定事項:");
        for (const d of t.decisions) parts.push(`- ${typeof d === 'string' ? d : (d as { text?: string }).text || JSON.stringify(d)}`);
      }
      if (t.action_items && Array.isArray(t.action_items) && t.action_items.length > 0) {
        parts.push("アクションアイテム:");
        for (const a of t.action_items) parts.push(`- ${typeof a === 'string' ? a : (a as { text?: string }).text || JSON.stringify(a)}`);
      }
    }
  }

  if (ctx.slack_messages.length > 0) {
    parts.push("\n## Slack会話");
    for (const m of ctx.slack_messages) {
      parts.push(`- [${m.channel_name || "DM"}] ${m.user_name || "不明"}: ${m.text || ""}`);
    }
  }

  if (ctx.sources.length > 0) {
    parts.push("\n## 追加ソース");
    for (const s of ctx.sources) {
      parts.push(`- [${s.source_type || "不明"}] ${s.title || "無題"}: ${s.content_preview || ""}`);
    }
  }

  return parts.join("\n");
}

/** Minimal markdown→HTML converter (ported verbatim). */
export function markdownToHtml(md: string): string {
  if (!md) return "";
  let html = md;

  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*?<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  if (!html.startsWith('<')) html = `<p>${html}</p>`;

  return html;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
