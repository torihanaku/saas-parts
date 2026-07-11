/**
 * Meeting ingest サービス（元: server/lib/cos/meeting-ingest.ts, COS-3）。
 *
 * パイプライン:
 *   1. 同意ゲート（`meeting_transcript_analysis`）— 無ければ静かにスキップ
 *      （個情法 18 条: 目的別の明示同意が必要）。
 *   2. 音声 → 書き起こし（Transcriber 注入。元は AssemblyAI diarized）。
 *   3. PII 最小化: digest には先頭 200 文字 + LLM 要約のみ保存。
 *      フル書き起こしは永続化しない。
 *   4. LLM で action item を構造化抽出 → `pending_review` でタスク保存。
 *      人間レビュー後に外部バックログへ同期（task-review / task-sync）。
 *
 * 失敗セマンティクス: 各ステップは構造化ログを出すがサービス境界を越えて
 * throw しない。呼び出し側は status で分岐できる。
 */
import type { ConsentChecker, CosLogger, LlmCaller } from "./types";
import { COS_CONSENT_PURPOSES, truncatePreview } from "./types";
import type { DigestStore, TaskStore } from "./stores";

// ─── Transcriber 抽象 ────────────────────────────────────────────────────────

export interface TranscribeInput {
  url: string;
  language?: string;
  speakerLabels?: boolean;
}

export interface TranscribeResult {
  text: string;
}

/** 書き起こしの注入点（元: AssemblyAI transcribe-client）。失敗時は throw してよい。 */
export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

// ─── プロンプト ──────────────────────────────────────────────────────────────

/** 抽出対象ドメインの既定値（元実装はマーケティング特化） */
export const DEFAULT_MEETING_DOMAIN = "マーケティング関連";

export function buildActionExtractionSystem(domainLabel: string): string {
  return `あなたは会議議事録から「${domainLabel}の action item (ToDo)」だけを抽出するアシスタントです。
JSON 配列のみを返してください: [{"task_text": "...", "assignee_hint": "...", "due_hint": "...", "source_quote": "..."}]
action item でない議論・雑談・情報共有のみのものは含めないでください。
JSON 以外の前置きや説明文は出力しないでください。`;
}

export function buildMeetingSummarySystem(domainLabel: string): string {
  return `あなたは会議議事録を 400 字以内で要約するアシスタントです。
${domainLabel}の意思決定・課題・宿題が分かるように簡潔に書いてください。
要約のみ出力し、前置きや見出しは付けないでください。`;
}

// ─── サービス ─────────────────────────────────────────────────────────────────

export interface MeetingIngestInput {
  /** テナントスコープ。同意チェックもこれに anchor する。 */
  tenantId: string;
  /** 実行ユーザー — `consent` 参照のみに使用し、永続化しない。 */
  userId: string;
  /** 音声 URL（Zoom cloud / GCS / signed URL）。Transcriber が取得する。 */
  audioUrl: string;
  meetingTitle: string;
  /** ISO-8601 の会議開始時刻 */
  meetingDate: string;
}

export interface MeetingIngestResult {
  /** 同意なしスキップ or digest 保存失敗時は null */
  digestId: string | null;
  /** 保存された action item 件数 */
  tasksExtracted: number;
  status: "skipped_no_consent" | "transcribe_failed" | "digest_insert_failed" | "ok";
}

interface RawExtractedTask {
  task_text?: unknown;
  assignee_hint?: unknown;
  due_hint?: unknown;
  source_quote?: unknown;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export interface MeetingIngestDeps {
  transcriber: Transcriber;
  digestStore: DigestStore;
  taskStore: TaskStore;
  consent: ConsentChecker;
  /** 未注入時は要約空文字・タスク抽出 0 件で digest のみ保存される */
  llm?: LlmCaller;
  logger?: CosLogger;
  /** 抽出対象ドメイン（プロダクト/部門名をここでパラメータ化） */
  domainLabel?: string;
}

export class MeetingIngestService {
  private readonly deps: MeetingIngestDeps;
  private readonly log: CosLogger;
  private readonly summarySystem: string;
  private readonly extractionSystem: string;

  constructor(deps: MeetingIngestDeps) {
    this.deps = deps;
    this.log = deps.logger ?? (() => {});
    const domain = deps.domainLabel ?? DEFAULT_MEETING_DOMAIN;
    this.summarySystem = buildMeetingSummarySystem(domain);
    this.extractionSystem = buildActionExtractionSystem(domain);
  }

  /** 書き起こし冒頭 12k 文字を 400 字要約（コスト上限のため head を使う）。 */
  private async summarizeTranscript(transcript: TranscribeResult): Promise<string> {
    if (!this.deps.llm) return "";
    const head = transcript.text.slice(0, 12_000);
    return await this.deps.llm.generateText(
      this.summarySystem,
      `会議議事録:\n${head}`,
      { maxTokens: 600, timeoutMs: 45_000 },
    );
  }

  /** LLM action item 抽出。失敗時は []。 */
  private async extractActionItems(
    transcript: TranscribeResult,
    meetingTitle: string,
    meetingDate: string,
  ): Promise<RawExtractedTask[]> {
    if (!this.deps.llm) return [];
    const text = transcript.text.slice(0, 16_000);
    const prompt = `会議: ${meetingTitle} (${meetingDate})\n議事録:\n${text}`;
    return await this.deps.llm.generateJson<RawExtractedTask[]>(
      this.extractionSystem,
      prompt,
      [],
      { maxTokens: 2_000, timeoutMs: 60_000 },
    );
  }

  private async insertDigest(
    input: MeetingIngestInput,
    transcript: TranscribeResult,
    summary: string,
  ): Promise<string | null> {
    const { preview, truncated } = truncatePreview(transcript.text);
    const result = await this.deps.digestStore.insert({
      tenantId: input.tenantId,
      sourceType: "meeting",
      sourcePermalink: input.audioUrl,
      sourceActor: null, // diarized speakers を実名解決しない
      rawTextPreview: preview,
      rawTextTruncated: truncated,
      summary,
      tags: ["meeting"],
      relevanceScore: 1.0,
    });
    if (!result.ok) {
      this.log("ERROR", "cos_meeting_digest_insert_failed", {
        tenant_id: input.tenantId,
        error: result.error,
      });
      return null;
    }
    return result.id;
  }

  private async insertTasks(
    tenantId: string,
    digestId: string,
    tasks: RawExtractedTask[],
  ): Promise<number> {
    let inserted = 0;
    for (const t of tasks) {
      const taskText = asString(t.task_text).trim();
      if (!taskText) continue;
      const r = await this.deps.taskStore.insert({
        tenantId,
        digestItemId: digestId,
        taskText,
        assigneeHint: asNullableString(t.assignee_hint),
        dueHint: asNullableString(t.due_hint),
        status: "pending_review",
      });
      if (r.ok) inserted++;
    }
    return inserted;
  }

  /** メインエントリポイント。パイプライン概要はモジュール docstring 参照。 */
  async ingest(input: MeetingIngestInput): Promise<MeetingIngestResult> {
    // ─── 同意ゲート ───────────────────────────────────────────────────────────
    const consented = await this.deps.consent(
      input.userId,
      input.tenantId,
      COS_CONSENT_PURPOSES.meeting,
    );
    if (!consented) {
      this.log("INFO", "cos_meeting_ingest_skipped_no_consent", {
        tenant_id: input.tenantId,
      });
      return { digestId: null, tasksExtracted: 0, status: "skipped_no_consent" };
    }

    // ─── 1. 書き起こし ────────────────────────────────────────────────────────
    let transcript: TranscribeResult;
    try {
      transcript = await this.deps.transcriber.transcribe({
        url: input.audioUrl,
        language: "ja",
        speakerLabels: true,
      });
    } catch (e) {
      this.log("WARNING", "cos_meeting_transcribe_failed", {
        tenant_id: input.tenantId,
        error: e instanceof Error ? e.message : "unknown",
      });
      return { digestId: null, tasksExtracted: 0, status: "transcribe_failed" };
    }

    // ─── 2. 要約 + digest 保存（truncated preview のみ） ─────────────────────
    const summary = await this.summarizeTranscript(transcript);
    const digestId = await this.insertDigest(input, transcript, summary);
    if (!digestId) {
      return { digestId: null, tasksExtracted: 0, status: "digest_insert_failed" };
    }

    // ─── 3. action item 抽出 + pending タスク保存 ────────────────────────────
    const tasks = await this.extractActionItems(
      transcript,
      input.meetingTitle,
      input.meetingDate,
    );
    if (!Array.isArray(tasks) || tasks.length === 0) {
      this.log("INFO", "cos_meeting_no_actions_extracted", {
        tenant_id: input.tenantId,
        digest_id: digestId,
      });
      return { digestId, tasksExtracted: 0, status: "ok" };
    }

    const tasksExtracted = await this.insertTasks(input.tenantId, digestId, tasks);
    this.log("INFO", "cos_meeting_ingest_completed", {
      tenant_id: input.tenantId,
      digest_id: digestId,
      tasks_extracted: tasksExtracted,
    });
    return { digestId, tasksExtracted, status: "ok" };
  }
}
