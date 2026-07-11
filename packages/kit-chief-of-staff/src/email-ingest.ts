/**
 * Email ingest サービス（元: server/lib/cos/email-ingest.ts, COS-4）。
 *
 * フィルタルールに合致するメールを取得し、LLM で「関連するか＋要約」を判定して
 * digest として保存する。本文は 200 文字に切り詰め（PII minimization 契約）。
 *
 * 汎用化: 元実装の Nango proxy 経由 Gmail/Outlook 取得は `EmailSource`
 * インターフェースに分離した（1 ルール → メッセージ封筒の配列を返す責務）。
 * Gmail/Outlook の検索クエリ構築・本文抽出は再利用可能なヘルパーとして残す。
 */
import type { ConsentChecker, CosLogger, EmailFilterRule, EmailIntegration, LlmCaller } from "./types";
import { COS_CONSENT_PURPOSES, truncatePreview } from "./types";
import type { DigestStore } from "./stores";

// ─── Source 抽象 ─────────────────────────────────────────────────────────────

export interface MessageEnvelope {
  id: string;
  permalink: string;
  from: string;
  subject: string;
  body: string;
}

/**
 * メール読み取りの注入点。Gmail / Outlook / IMAP 等の実装は利用側が用意する
 * （元実装は Nango proxy。buildEmailQuery / extractPlainText が実装の部品になる）。
 */
export interface EmailSource {
  listEnvelopes(rule: EmailFilterRule, sinceIso: string): Promise<MessageEnvelope[]>;
}

// ─── 検索クエリ / 本文抽出ヘルパー（Gmail / Outlook 実装用の部品） ────────────

/** Gmail / Outlook の検索クエリをフィルタルールから構築する。 */
export function buildEmailQuery(
  integration: EmailIntegration,
  rule: EmailFilterRule,
  sinceIso: string,
): string {
  const datePart = new Date(sinceIso).toISOString().slice(0, 10);
  const parts: string[] = [`after:${datePart}`];
  if (rule.fromDomain) parts.push(`from:@${rule.fromDomain}`);
  if (rule.subjectContains) parts.push(`subject:(${rule.subjectContains})`);
  if (rule.labelIncludes) {
    parts.push(
      integration === "outlook"
        ? `category:(${rule.labelIncludes})`
        : `label:${rule.labelIncludes}`,
    );
  }
  return parts.join(" ");
}

/** Gmail 形式 payload から text/plain 本文を抽出。無ければ snippet 系にフォールバック。 */
export function extractPlainText(message: Record<string, unknown>): string {
  const payload = message.payload as Record<string, unknown> | undefined;
  if (payload) {
    const fromTree = walkForPlainText(payload);
    if (fromTree) return fromTree;
  }
  const snippet = message.snippet ?? message.body ?? message.bodyPreview;
  return typeof snippet === "string" ? snippet : "";
}

function walkForPlainText(node: Record<string, unknown>): string {
  const mimeType = typeof node.mimeType === "string" ? node.mimeType : "";
  const body = node.body as { data?: string } | undefined;
  if (mimeType === "text/plain" && typeof body?.data === "string") {
    return decodeBase64Url(body.data);
  }
  const parts = node.parts as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(parts)) {
    for (const child of parts) {
      const out = walkForPlainText(child);
      if (out) return out;
    }
  }
  return "";
}

function decodeBase64Url(b64: string): string {
  try {
    const normalised = b64.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalised, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

// ─── サービス ─────────────────────────────────────────────────────────────────

export interface EmailIngestInput {
  tenantId: string;
  filterRules: EmailFilterRule[];
  /** この ISO 時刻以降のメッセージを取得。ウォーターマーク前進は呼び出し側（cron）の責務。 */
  sinceIso: string;
  /** 同意チェックの actor。既定 "cos-cron-system"。 */
  systemUserId?: string;
}

export interface EmailIngestResult {
  ingested: number;
  /** -1 = 同意なし; >=0 = スキップ件数 */
  skipped: number;
}

interface EmailSummaryJudgement {
  relevant: boolean;
  summary?: string;
  tags?: string[];
  action_needed?: string;
}

const MAX_LLM_BODY_CHARS = 2000;
const SUMMARY_MAX_TOKENS = 300;

/** 抽出対象ドメインの既定値（元実装はマーケティング特化） */
export const DEFAULT_EMAIL_TOPIC =
  "マーケ関連情報 (施策結果 / 代理店提案 / クライアントFB / 広告レポート / PR)";

export function buildEmailSummaryPrompt(topic: string): string {
  return `あなたはメール要約アシスタント。 ${topic}を抽出。
出力は次の JSON だけ: {"relevant": true|false, "summary": "50-100字", "tags": ["agency"|"feedback"|"report"|"campaign"|"pr"|"other"], "action_needed": "次の一手 (任意)"}
無関係 (個人連絡 / 自動通知 / newsletter) なら relevant=false で他は省略可。`;
}

export interface EmailIngestDeps {
  source: EmailSource;
  digestStore: DigestStore;
  consent: ConsentChecker;
  /** 未注入時は ingest せず {ingested:0, skipped:0} を返す（元: API キー無し相当） */
  llm?: LlmCaller;
  logger?: CosLogger;
  /** 抽出対象トピック（プロダクト/ドメイン名をここでパラメータ化） */
  topic?: string;
}

export class EmailIngestService {
  private readonly deps: EmailIngestDeps;
  private readonly log: CosLogger;
  private readonly summaryPrompt: string;

  constructor(deps: EmailIngestDeps) {
    this.deps = deps;
    this.log = deps.logger ?? (() => {});
    this.summaryPrompt = buildEmailSummaryPrompt(deps.topic ?? DEFAULT_EMAIL_TOPIC);
  }

  async ingest(input: EmailIngestInput): Promise<EmailIngestResult> {
    const systemUserId = input.systemUserId ?? "cos-cron-system";

    const consentOk = await this.deps.consent(
      systemUserId,
      input.tenantId,
      COS_CONSENT_PURPOSES.email,
    );
    if (!consentOk) return { ingested: 0, skipped: -1 };

    if (!this.deps.llm) {
      this.log("WARNING", "cos_email_ingest_skipped_no_llm", {
        tenant_id: input.tenantId,
      });
      return { ingested: 0, skipped: 0 };
    }

    let ingested = 0;
    let skipped = 0;

    for (const rule of input.filterRules) {
      const envelopes = await this.deps.source.listEnvelopes(rule, input.sinceIso);

      for (const envelope of envelopes) {
        try {
          const summary = await this.summarise(envelope);
          if (!summary.relevant) {
            skipped++;
            continue;
          }
          const ok = await this.persistDigestItem(input.tenantId, envelope, summary);
          if (ok) ingested++;
          else skipped++;
        } catch (err: unknown) {
          this.log("WARNING", "cos_email_ingest_item_failed", {
            tenant_id: input.tenantId,
            message_id: envelope.id,
            error: err instanceof Error ? err.message : String(err),
          });
          skipped++;
        }
      }
    }

    return { ingested, skipped };
  }

  private async summarise(envelope: MessageEnvelope): Promise<EmailSummaryJudgement> {
    const userPrompt = `From: ${envelope.from}\nSubject: ${envelope.subject}\nBody: ${envelope.body.slice(0, MAX_LLM_BODY_CHARS)}`;
    return this.deps.llm!.generateJson<EmailSummaryJudgement>(
      this.summaryPrompt,
      userPrompt,
      { relevant: false },
      { maxTokens: SUMMARY_MAX_TOKENS },
    );
  }

  private async persistDigestItem(
    tenantId: string,
    envelope: MessageEnvelope,
    summary: EmailSummaryJudgement,
  ): Promise<boolean> {
    const { preview, truncated } = truncatePreview(envelope.body ?? "");
    const result = await this.deps.digestStore.insert({
      tenantId,
      sourceType: "email",
      sourcePermalink: envelope.permalink,
      sourceActor: envelope.from ? `email:${envelope.from}` : null,
      rawTextPreview: preview,
      rawTextTruncated: truncated,
      summary: summary.summary ?? "",
      tags: Array.isArray(summary.tags) ? summary.tags : [],
      relevanceScore: 0.8, // filter rule を通過した時点で関連性が高い
    });
    if (!result.ok) {
      this.log("WARNING", "cos_email_ingest_persist_failed", {
        tenant_id: tenantId,
        message_id: envelope.id,
        error: result.error,
      });
      return false;
    }
    return true;
  }
}
