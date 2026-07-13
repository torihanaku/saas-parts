/**
 * マルチプラットフォーム・コンテンツ発行。
 *
 * 出典: 実運用SaaS server/lib/nango-operations.ts（publish系）。
 * プラットフォーム別のエンドポイント/ボディ構築（buildPublishPayload）は元実装のまま。
 * 汎用化ポイント:
 *   - proxyRequest 直呼び → IntegrationProvider.publish 注入
 *   - 発行成功時の Supabase 直接更新（dd_content_drafts）→ onPublished コールバック注入
 */
import type { IntegrationProvider } from "./types";

// ─── 型 ──────────────────────────────────────────────────────────────────────

export type PublishPlatform = "slack" | "wordpress" | "linkedin" | "line" | "note" | "mailchimp";

export interface PublishTarget {
  platform: PublishPlatform;
  connectionId: string;
  /** 統合キー（省略時はプラットフォーム名） */
  integrationId?: string;
  /** Slackチャンネル上書き（既定: #general） */
  slackChannel?: string;
  /** LINEのグループ/ユーザーID（push messages用） */
  lineGroupId?: string;
  /** メールキャンペーンの差出人名（Mailchimp） */
  fromName?: string;
}

export interface PublishResult {
  ok: boolean;
  platform: string;
  error?: string;
}

export interface ContentDraft {
  id: string;
  title: string;
  content: string;
}

/** 発行成功時のフック（下書きの published マーク等を呼び出し側で行う） */
export type OnPublished = (draft: ContentDraft, platform: string) => Promise<void>;

// ─── ペイロード構築 ──────────────────────────────────────────────────────────

/** プラットフォーム別のエンドポイント + ボディを組み立てる（元実装のまま） */
export function buildPublishPayload(
  platform: string,
  title: string,
  content: string,
  options: { slackChannel?: string; lineGroupId?: string; fromName?: string } = {},
): { endpoint: string; body: Record<string, unknown> } | null {
  switch (platform) {
    case "slack":
      return {
        endpoint: "/chat.postMessage",
        body: {
          channel: options.slackChannel ?? "#general",
          text: `${title}\n\n${content.substring(0, 500)}`,
        },
      };
    case "wordpress":
      return {
        endpoint: "/wp/v2/posts",
        body: { title, content, status: "publish" },
      };
    case "linkedin":
      return {
        endpoint: "/ugcPosts",
        body: { commentary: content.substring(0, 700) },
      };
    case "line":
      return {
        endpoint: "/v2/bot/message/push",
        body: {
          to: options.lineGroupId ?? "",
          messages: [{ type: "text", text: `${title}\n\n${content.substring(0, 2000)}` }],
        },
      };
    case "note":
      return {
        endpoint: "/api/v2/notes",
        body: { title, body: content, status: "draft" },
      };
    case "mailchimp":
      return {
        endpoint: "/campaigns",
        body: {
          type: "regular",
          settings: {
            subject_line: title,
            from_name: options.fromName ?? "",
          },
        },
      };
    default:
      return null;
  }
}

// ─── 発行 ────────────────────────────────────────────────────────────────────

/** 1プラットフォームへ下書きを発行する */
export async function publishToPlatform(
  provider: IntegrationProvider,
  tenantId: string,
  draft: ContentDraft,
  target: PublishTarget,
  onPublished?: OnPublished,
): Promise<PublishResult> {
  const { platform, connectionId, integrationId = platform, slackChannel, lineGroupId, fromName } =
    target;

  const payload = buildPublishPayload(platform, draft.title, draft.content, {
    slackChannel,
    lineGroupId,
    fromName,
  });
  if (!payload) {
    return { ok: false, platform, error: `未対応のプラットフォーム: ${platform}` };
  }

  try {
    const result = await provider.publish(tenantId, integrationId, connectionId, {
      method: "POST",
      endpoint: payload.endpoint,
      body: payload.body,
    });
    if (!result) return { ok: false, platform, error: "provider publish returned null" };

    if (onPublished) await onPublished(draft, platform);

    return { ok: true, platform };
  } catch (e: unknown) {
    return {
      ok: false,
      platform,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 複数プラットフォームへ並列発行する。ターゲットごとに PublishResult を返す */
export async function publishToMultiplePlatforms(
  provider: IntegrationProvider,
  tenantId: string,
  draft: ContentDraft,
  targets: PublishTarget[],
  onPublished?: OnPublished,
): Promise<PublishResult[]> {
  return Promise.all(targets.map((t) => publishToPlatform(provider, tenantId, draft, t, onPublished)));
}
