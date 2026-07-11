/**
 * Transcript domain types.
 * Ported from dev-dashboard-v2 `server/routes/transcripts/` (#226).
 */

/** Transcript lifecycle: pending → transcribing → structuring → completed | error. */
export type TranscriptStatus =
  | "pending"
  | "transcribing"
  | "structuring"
  | "completed"
  | "error";

export interface TranscriptRecord {
  id: string;
  project_id: string;
  user_id: string;
  title: string;
  audio_filename: string | null;
  audio_size_bytes: number | null;
  audio_duration_seconds: number | null;
  audio_mime_type: string | null;
  raw_transcript: string | null;
  summary: string | null;
  decisions: unknown[];
  action_items: unknown[];
  key_points: unknown[];
  participants: unknown[];
  status: TranscriptStatus | string;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Search projection (matches the original search SELECT). */
export type TranscriptSearchItem = Pick<
  TranscriptRecord,
  "id" | "project_id" | "user_id" | "title" | "summary" | "status" | "created_at" | "updated_at"
>;

/** Structured extraction output from the LLM structuring step. */
export interface StructuredTranscript {
  summary: string;
  decisions: unknown[];
  action_items: unknown[];
  key_points: unknown[];
  participants: unknown[];
}

/** Extracted action item (backlog registration). */
export interface ExtractedActionItem {
  title: string;
  owner?: string | null;
  priority?: "high" | "medium" | "low";
  due_date?: string | null;
}

// ─── Audio validation (ported constants) ──────────────────────────────────────

export const MAX_AUDIO_SIZE = 50 * 1024 * 1024;

export const ALLOWED_AUDIO_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/m4a",
];

/** Mirrors the upload validation: allow by MIME type OR by known extension. */
export function isAllowedAudio(fileName: string, fileType: string): boolean {
  return ALLOWED_AUDIO_TYPES.includes(fileType) || /\.(mp3|wav|m4a|webm)$/i.test(fileName);
}

export function isValidUUID(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * The structuring prompt sent to the LLM. Kept as a builder so the port matches
 * the original wording; the LLM call itself is injected.
 */
export function buildStructuringPrompt(rawTranscript: string): string {
  return `以下は会議やミーティングの文字起こしです。この内容を構造化して、JSON形式で返してください。

## 文字起こし内容
${rawTranscript}

## 出力形式（必ずこのJSON形式で返してください）
{
  "summary": "会議の要約（2-3文）",
  "decisions": [{"text": "決定事項", "context": "背景・理由"}],
  "action_items": [{"text": "アクション内容", "assignee": "担当者名またはnull", "due_date": "期限またはnull"}],
  "key_points": [{"text": "重要ポイント", "category": "カテゴリ（議論/報告/提案など）"}],
  "participants": [{"name": "参加者名", "role": "役割またはnull"}]
}

JSONのみを返してください。説明は不要です。`;
}

/** Parses the LLM structuring response, tolerating ```json fences. */
export function parseStructuredResponse(content: string): StructuredTranscript {
  let jsonStr = content;
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch && jsonMatch[1]) jsonStr = jsonMatch[1].trim();
  try {
    return JSON.parse(jsonStr) as StructuredTranscript;
  } catch {
    return { summary: content, decisions: [], action_items: [], key_points: [], participants: [] };
  }
}
