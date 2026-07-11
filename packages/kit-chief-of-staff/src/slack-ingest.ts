/**
 * Slack ingest サービス（元: server/lib/cos/slack-ingest.ts, COS-2）。
 *
 * テナント設定のチャンネルから直近メッセージを取得し、LLM で関連度を判定して
 * 閾値以上のものだけ digest として保存する。
 *
 * コンプライアンス契約（個情法 18 条 / PII minimization）:
 *   - オーナーの `slack_content_analysis` 同意が無ければハードスキップ
 *   - raw_text_preview ≤ 200 文字、切り詰め時は raw_text_truncated=true
 *   - source_actor は `slack:<user_id>` のみ（表示名は保存しない）
 *
 * 汎用化: Slack Web API 直叩きは `SlackSource` インターフェースに分離し、
 * `createSlackWebApiSource`（fetch 注入）を参考実装として同梱。
 */
import type {
  ConsentChecker,
  CosLogger,
  FetchLike,
  LlmCaller,
} from "./types";
import { COS_CONSENT_PURPOSES, COS_RAW_TEXT_PREVIEW_MAX, truncatePreview } from "./types";
import type { DigestStore, TenantSettingsStore } from "./stores";

// ─── Source 抽象 ─────────────────────────────────────────────────────────────

export interface SlackMessage {
  ts?: string;
  user?: string;
  text?: string;
  type?: string;
  subtype?: string;
}

/** Slack 読み取りの注入点。実装例は createSlackWebApiSource。 */
export interface SlackSource {
  /** oldest は epoch 秒（文字列）。ts があり text が空でないものだけ返す。 */
  fetchHistory(channel: string, oldest: string): Promise<SlackMessage[]>;
  /** 失敗時は `slack://<channel>/<ts>` フォールバックを返す（throw しない）。 */
  fetchPermalink(channel: string, ts: string): Promise<string>;
}

const SLACK_HISTORY_LIMIT = 100;

/** Slack Web API を使う参考実装。fetch は注入可能（既定 globalThis.fetch）。 */
export function createSlackWebApiSource(
  botToken: string,
  fetchImpl: FetchLike = fetch,
): SlackSource {
  return {
    async fetchHistory(channel: string, oldest: string): Promise<SlackMessage[]> {
      const params = new URLSearchParams({
        channel,
        limit: String(SLACK_HISTORY_LIMIT),
        oldest,
      });
      const res = await fetchImpl(
        `https://slack.com/api/conversations.history?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${botToken}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) throw new Error(`slack_history_http_${res.status}`);
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        messages?: SlackMessage[];
      };
      if (!data.ok) throw new Error(`slack_history_${data.error ?? "unknown"}`);
      return (data.messages ?? []).filter((m) => m.ts && (m.text ?? "").length > 0);
    },

    async fetchPermalink(channel: string, ts: string): Promise<string> {
      try {
        const params = new URLSearchParams({ channel, message_ts: ts });
        const res = await fetchImpl(
          `https://slack.com/api/chat.getPermalink?${params.toString()}`,
          {
            headers: { Authorization: `Bearer ${botToken}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!res.ok) return `slack://${channel}/${ts}`;
        const data = (await res.json()) as { ok: boolean; permalink?: string };
        return data.ok && data.permalink ? data.permalink : `slack://${channel}/${ts}`;
      } catch {
        return `slack://${channel}/${ts}`;
      }
    },
  };
}

// ─── サービス ─────────────────────────────────────────────────────────────────

export interface SlackIngestInput {
  tenantId: string;
  /** 同意チェックの対象（テナント設定のオーナー） */
  ownerUserId: string;
  channels: string[];
  /** RFC-3339 ISO 8601 — Slack の `oldest`（epoch 秒）に変換される */
  sinceIso: string;
}

export interface SlackIngestResult {
  ingested: number;
  skipped: number;
  /** 同意が無く全体をスキップした場合 true */
  consentMissing?: boolean;
}

interface RelevanceJudgement {
  relevant: boolean;
  relevance_score: number;
  tags: string[];
  summary: string;
}

const RELEVANCE_FALLBACK: RelevanceJudgement = {
  relevant: false,
  relevance_score: 0,
  tags: [],
  summary: "",
};

export const SLACK_RELEVANCE_THRESHOLD = 0.4;
const RAW_TEXT_LLM_LIMIT = 1500;

/** 判定対象トピックの既定値（元実装はマーケティング特化） */
export const DEFAULT_SLACK_TOPIC =
  "マーケティング関連（キャンペーン・コンテンツ・広告・PR・施策の議論）";

export function buildSlackRelevancePrompt(topic: string): string {
  return `以下の Slack message が${topic}か判定してください。
JSON 形式で {"relevant": true/false, "relevance_score": 0.0-1.0, "tags": ["marketing","campaign",...], "summary": "50字程度の日本語要約"} を返してください。
関連しない場合は relevant: false。`;
}

export function isoToSlackOldest(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "0";
  return (ms / 1000).toFixed(6);
}

export interface SlackIngestDeps {
  source: SlackSource;
  digestStore: DigestStore;
  consent: ConsentChecker;
  /** 未注入時は全メッセージが「関連なし」としてスキップされる（元: API キー無し相当） */
  llm?: LlmCaller;
  settingsStore?: TenantSettingsStore;
  logger?: CosLogger;
  /** 関連度判定のトピック（プロダクト/ドメイン名をここでパラメータ化） */
  topic?: string;
}

export class SlackIngestService {
  private readonly deps: SlackIngestDeps;
  private readonly log: CosLogger;
  private readonly relevancePrompt: string;

  constructor(deps: SlackIngestDeps) {
    this.deps = deps;
    this.log = deps.logger ?? (() => {});
    this.relevancePrompt = buildSlackRelevancePrompt(deps.topic ?? DEFAULT_SLACK_TOPIC);
  }

  private async judgeRelevance(rawText: string): Promise<RelevanceJudgement> {
    const llm = this.deps.llm;
    if (!llm) return RELEVANCE_FALLBACK;
    try {
      const parsed = await llm.generateJson<Partial<RelevanceJudgement>>(
        "You are a precise classifier. Output strictly the requested JSON, no prose.",
        `${this.relevancePrompt}\n\nMessage:\n${rawText.slice(0, RAW_TEXT_LLM_LIMIT)}`,
        RELEVANCE_FALLBACK,
        { maxTokens: 200, timeoutMs: 20_000 },
      );
      return {
        relevant: !!parsed.relevant,
        relevance_score:
          typeof parsed.relevance_score === "number" ? parsed.relevance_score : 0,
        tags: Array.isArray(parsed.tags)
          ? parsed.tags.filter((t): t is string => typeof t === "string").slice(0, 16)
          : [],
        summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 200) : "",
      };
    } catch {
      return RELEVANCE_FALLBACK;
    }
  }

  async ingest(input: SlackIngestInput): Promise<SlackIngestResult> {
    const consented = await this.deps.consent(
      input.ownerUserId,
      input.tenantId,
      COS_CONSENT_PURPOSES.slack,
    );
    if (!consented) {
      this.log("INFO", "cos_slack_ingest_skipped_no_consent", {
        tenant_id: input.tenantId,
      });
      return { ingested: 0, skipped: 0, consentMissing: true };
    }

    const oldest = isoToSlackOldest(input.sinceIso);
    let ingested = 0;
    let skipped = 0;

    for (const channel of input.channels) {
      let messages: SlackMessage[];
      try {
        messages = await this.deps.source.fetchHistory(channel, oldest);
      } catch (e) {
        this.log("WARNING", "cos_slack_ingest_history_failed", {
          tenant_id: input.tenantId,
          channel,
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      for (const msg of messages) {
        try {
          const raw = msg.text ?? "";
          if (!raw.trim()) {
            skipped++;
            continue;
          }
          const { preview, truncated } = truncatePreview(raw);

          const judgement = await this.judgeRelevance(raw);
          if (!judgement.relevant || judgement.relevance_score < SLACK_RELEVANCE_THRESHOLD) {
            skipped++;
            continue;
          }

          const permalink = await this.deps.source.fetchPermalink(channel, msg.ts!);
          const insertResult = await this.deps.digestStore.insert({
            tenantId: input.tenantId,
            sourceType: "slack",
            sourcePermalink: permalink,
            sourceActor: msg.user ? `slack:${msg.user}` : null,
            rawTextPreview: preview.slice(0, COS_RAW_TEXT_PREVIEW_MAX),
            rawTextTruncated: truncated,
            summary: judgement.summary,
            tags: judgement.tags,
            relevanceScore: judgement.relevance_score,
          });

          if (insertResult.ok) {
            ingested++;
          } else {
            skipped++;
            this.log("WARNING", "cos_slack_ingest_insert_failed", {
              tenant_id: input.tenantId,
              channel,
              ts: msg.ts,
              error: insertResult.error,
            });
          }
        } catch (e) {
          skipped++;
          this.log("WARNING", "cos_slack_ingest_item_failed", {
            tenant_id: input.tenantId,
            channel,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    // ベストエフォート: ウォーターマーク更新（非クリティカル）
    if (this.deps.settingsStore) {
      try {
        await this.deps.settingsStore.setWatermark(
          input.tenantId,
          "slack",
          new Date().toISOString(),
        );
      } catch {
        /* ignored */
      }
    }

    this.log("INFO", "cos_slack_ingest_completed", {
      tenant_id: input.tenantId,
      channels: input.channels.length,
      ingested,
      skipped,
    });

    return { ingested, skipped };
  }

  /** Slack ingest が有効なテナント一覧（briefing on ＋ チャンネル 1 つ以上） */
  async listIngestEnabledTenants(): Promise<
    { tenantId: string; ownerUserId: string; channels: string[]; lastIngestedAt: string | null }[]
  > {
    if (!this.deps.settingsStore) return [];
    const rows = await this.deps.settingsStore.listBriefingEnabled();
    return rows
      .filter((r) => Array.isArray(r.slackChannels) && r.slackChannels.length > 0)
      .map((r) => ({
        tenantId: r.tenantId,
        ownerUserId: r.ownerUserId,
        channels: r.slackChannels,
        lastIngestedAt: r.lastSlackIngestedAt,
      }));
  }
}
