/**
 * Chief of Staff (COS) kit — 共有型と注入インターフェース。
 *
 * 出典: 実運用SaaS shared/types/cos.ts（COS-1 Foundation）＋
 * server/lib/cos/* の暗黙依存（Claude / consent / Supabase / logger）を
 * 明示的な注入インターフェースとして抽出したもの。
 */

// ─── ドメイン型（COS-1 スキーマの camelCase ミラー） ─────────────────────────

export type CosSourceType = "slack" | "email" | "meeting";

export type CosTaskStatus = "pending_review" | "confirmed" | "rejected" | "synced";

/** 代表的な同期先。TaskReviewService は任意の文字列キーも許容する。 */
export type CosTaskSyncTarget = "github_issue" | "linear";

export type CosBriefingType = "daily" | "weekly" | "status_report";

/** cos_digest_items 行 */
export interface CosDigestItem {
  id: string;
  tenantId: string;
  sourceType: CosSourceType;
  sourcePermalink: string;
  sourceActor: string | null;
  /** 先頭 200 文字（PII minimization） */
  rawTextPreview: string;
  rawTextTruncated: boolean;
  summary: string;
  tags: string[];
  /** 0.00–1.00 */
  relevanceScore: number | null;
  ingestedAt: string;
}

/** cos_extracted_tasks 行 */
export interface CosExtractedTask {
  id: string;
  tenantId: string;
  digestItemId: string | null;
  taskText: string;
  assigneeHint: string | null;
  dueHint: string | null;
  status: CosTaskStatus;
  syncedTo: string | null;
  externalId: string | null;
  createdAt: string;
}

/** cos_briefings 行 */
export interface CosBriefing {
  id: string;
  tenantId: string;
  briefingType: CosBriefingType;
  periodStart: string;
  periodEnd: string;
  summaryText: string;
  /** Top 5 digest item ids */
  keyItemsJson: string[];
  deliveredTo: string[];
  generatedAt: string;
}

/** cos_tenant_settings 行 */
export interface CosTenantSettings {
  tenantId: string;
  /** consent チェックの対象ユーザー（cron でもこの人の同意を毎回確認する） */
  ownerUserId: string;
  slackChannels: string[];
  emailFilterRules: unknown[];
  meetingSources: string[];
  dailyBriefingEnabled: boolean;
  /** "HH:MM"（ローカル時刻） */
  dailyBriefingTime: string;
  lastSlackIngestedAt: string | null;
  lastEmailIngestedAt: string | null;
  lastMeetingIngestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** cos_email_settings 行 */
export interface CosEmailSettings {
  tenantId: string;
  integration: EmailIntegration;
  connectionId: string | null;
  enabled: boolean;
  filterRules: EmailFilterRule[];
  /** 1〜168 時間 */
  lookbackHours: number;
  lastRunAt: string | null;
}

export type EmailIntegration = "google-mail" | "outlook";

export interface EmailFilterRule {
  fromDomain?: string;
  subjectContains?: string;
  labelIncludes?: string;
}

/** raw_text_preview の最大長。アプリ層と DB CHECK の両方で強制する。 */
export const COS_RAW_TEXT_PREVIEW_MAX = 200;

/**
 * PII 最小化のため raw テキストを preview 長に切り詰める。
 * preview と truncated フラグを返す。
 */
export function truncatePreview(raw: string): { preview: string; truncated: boolean } {
  if (raw.length <= COS_RAW_TEXT_PREVIEW_MAX) {
    return { preview: raw, truncated: false };
  }
  return { preview: raw.slice(0, COS_RAW_TEXT_PREVIEW_MAX), truncated: true };
}

// ─── 注入インターフェース ─────────────────────────────────────────────────────

export interface LlmOptions {
  maxTokens?: number;
  /** ミリ秒 */
  timeoutMs?: number;
}

/**
 * LLM 呼び出しの注入点。元実装の claude-api-client
 * （generateText / generateJson）に対応。@torihanaku/claude-api で満たせる。
 * 失敗時は例外ではなく generateText→"" / generateJson→fallback を返す契約。
 */
export interface LlmCaller {
  generateText(system: string, prompt: string, opts?: LlmOptions): Promise<string>;
  generateJson<T>(system: string, prompt: string, fallback: T, opts?: LlmOptions): Promise<T>;
}

/**
 * 目的ベース同意チェックの注入点（個情法 18 条対応）。
 * @torihanaku/consent の hasConsent がこのシグネチャを満たす。
 */
export type ConsentChecker = (
  userId: string,
  tenantId: string,
  purpose: string,
) => Promise<boolean>;

/** COS が参照する同意目的（元 sup_consent_registry の purpose 値） */
export const COS_CONSENT_PURPOSES = {
  slack: "slack_content_analysis",
  email: "email_content_analysis",
  meeting: "meeting_transcript_analysis",
} as const;

export type CosLogSeverity = "INFO" | "WARNING" | "ERROR";

/** 構造化ログの注入点。未注入時は no-op。 */
export type CosLogger = (
  severity: CosLogSeverity,
  message: string,
  fields?: Record<string, unknown>,
) => void;

export type FetchLike = typeof fetch;

/** テキスト → 埋め込みベクトル（QaEngine の意思決定ログ検索で使用・任意） */
export type Embedder = (text: string) => Promise<number[]>;

// ─── 共通結果型 ───────────────────────────────────────────────────────────────

export type StoreResult =
  | { ok: true; id: string }
  | { ok: false; error: string };
