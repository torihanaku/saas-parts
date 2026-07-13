/**
 * SEO adapter for the Autonomous Deploy Agent — アダプタ実装の一例。
 *
 * `dd_seo_tracking` には書かない（そこは analytics import path の所有）。デプロイ
 * 設定は `dd_deploy_targets`（kind='seo', platform='google-search-console'）に置く。
 *
 * target が `options.url` を持つか、承認済み submission テキストから URL 抽出できる
 * 場合に、（原典では Nango proxy 経由で）Google Indexing API を叩く。
 *
 * 出典: 実運用SaaS server/lib/autonomous-deploy/adapters/seo-adapter.ts
 *
 * 移植方針:
 * - `proxyRequest`（Nango client）→ `proxyRequest` 注入。
 * - `getSupabaseAdmin`（target 読み出し）→ `loadTargets` 注入。
 * - `isEnabled("autonomousDeploy")` → `enabled` 述語注入（省略時 true）。
 * - URL 抽出・payload 生成（buildSeoIndexingPayload）は原典のまま純粋関数として export。
 */

import type {
  DeployAdapter,
  DeployAdapterResult,
  DeployStep,
  SubmissionRecord,
} from "../types";

export type SeoPlatform = "google-search-console";
export type IndexingNotificationType = "URL_UPDATED" | "URL_DELETED";

export interface SeoTargetRow {
  platform: SeoPlatform;
  connection_id: string;
  options?: Record<string, unknown>;
}

interface SeoIndexOutcome {
  platform: SeoPlatform;
  url?: string;
  status: "success" | "skipped";
  reason?: string;
  connection_id?: string;
  notification_type?: IndexingNotificationType;
}

interface SeoIndexingPayload {
  endpoint: string;
  body: {
    url: string;
    type: IndexingNotificationType;
  };
}

/**
 * 外部プロキシ呼び出し（原典 Nango proxyRequest 互換）。null で「送信できなかった」を表す。
 */
export type ProxyRequestFn = (
  tenantId: string,
  platform: string,
  connectionId: string,
  method: string,
  endpoint: string,
  body: unknown,
) => Promise<Record<string, unknown> | null>;

/** テナントの有効な SEO ターゲットを読み出す（原典 dd_deploy_targets 相当）。 */
export type LoadSeoTargets = (tenantId: string) => Promise<SeoTargetRow[]>;

export interface SeoAdapterConfig {
  proxyRequest: ProxyRequestFn;
  loadTargets: LoadSeoTargets;
  /** 実行可否（原典 feature flag）。省略時は常に有効。 */
  enabled?: () => boolean;
}

export class SeoAdapter implements DeployAdapter {
  readonly target = "seo" as const;

  constructor(private readonly config: SeoAdapterConfig) {}

  async run(submission: SubmissionRecord): Promise<DeployAdapterResult> {
    const isEnabled = this.config.enabled ?? (() => true);
    if (!isEnabled()) {
      return { status: "skipped", reason: "feature_flag_disabled" };
    }

    const targets = await this.config.loadTargets(submission.tenant_id);
    if (targets.length === 0) {
      return {
        status: "skipped",
        reason: "no_seo_targets_configured",
        detail: { adapter: "seo" },
      };
    }

    const outcomes: SeoIndexOutcome[] = [];
    for (const target of targets) {
      outcomes.push(await this.notifyIndexing(submission, target));
    }

    const succeeded = outcomes.filter((o) => o.status === "success");
    if (succeeded.length === 0) {
      throw new Error(
        `seo_all_targets_failed: ${outcomes.map((o) => `${o.platform}=${o.reason ?? "unknown"}`).join(",")}`,
      );
    }

    return {
      status: "success",
      detail: {
        adapter: "seo",
        indexed: succeeded.map((o) => ({
          platform: o.platform,
          url: o.url,
          connection_id: o.connection_id,
          notification_type: o.notification_type,
        })),
      },
    };
  }

  async rollback(_submission: SubmissionRecord, _step: DeployStep): Promise<void> {
    // Indexing notifications are not safely reversible. Sending URL_DELETED
    // would be destructive unless the page was actually removed, so operators
    // handle SEO rollback from the deploy log detail.
  }

  private async notifyIndexing(
    submission: SubmissionRecord,
    target: SeoTargetRow,
  ): Promise<SeoIndexOutcome> {
    if (!target.connection_id) {
      return { platform: target.platform, status: "skipped", reason: "no_connection" };
    }

    const payload = buildSeoIndexingPayload(submission, target.options ?? {});
    if (!payload) {
      return { platform: target.platform, status: "skipped", reason: "no_indexable_url" };
    }

    const result = await this.config.proxyRequest(
      submission.tenant_id,
      target.platform,
      target.connection_id,
      "POST",
      payload.endpoint,
      payload.body,
    );
    if (!result) {
      return { platform: target.platform, status: "skipped", reason: "proxy_returned_null" };
    }

    return {
      platform: target.platform,
      status: "success",
      url: payload.body.url,
      connection_id: target.connection_id,
      notification_type: payload.body.type,
    };
  }
}

export function buildSeoIndexingPayload(
  submission: Pick<SubmissionRecord, "title" | "content_text">,
  options: Record<string, unknown> = {},
): SeoIndexingPayload | null {
  const url = normalizeUrl(
    typeof options.url === "string" && options.url
      ? options.url
      : extractFirstUrl(`${submission.title}\n${submission.content_text}`),
  );
  if (!url) return null;

  const type = options.notification_type === "URL_DELETED" ? "URL_DELETED" : "URL_UPDATED";
  return {
    endpoint: "/v3/urlNotifications:publish",
    body: { url, type },
  };
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"')]+/i);
  return match?.[0] ?? null;
}

function normalizeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
