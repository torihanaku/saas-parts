/**
 * 統合別データ正規化（ノーマライザ）レジストリ。
 *
 * 出典: dev-dashboard-v2 server/lib/nango-sync.ts の
 * INTEGRATION_TO_SOURCE_TYPE + SYNC_CONFIGS + transform関数群。
 * 汎用化ポイント:
 *   - 固定の Record マップ → register/resolve できるレジストリクラス
 *   - project_id → scopeId（同期先スコープの識別子。呼び出し側の任意単位）
 *
 * 例として3つ（Slackメッセージ / メール / GA4レポート）を移植して残し、
 * 残り（document/notion/ticket/gsc/google-ads/meta-ads 等）は落とした（README参照）。
 * 未登録の統合には汎用フォールバック（normalizeGeneric）が使われる。
 */

// ─── 型 ──────────────────────────────────────────────────────────────────────

/** 正規化済みレコード（元: cockpit_project_sources 行） */
export interface NormalizedRecord {
  /** 同期先スコープ（元: project_id）。SyncEngine が設定する */
  scope_id: string;
  title: string;
  /** DB上のソース種別（元: INTEGRATION_TO_SOURCE_TYPE の右辺） */
  source_type: string;
  content: string;
  /** 重複排除キー。空なら毎回insertされる */
  external_id?: string;
  metadata?: Record<string, unknown>;
}

/** 生レコード → 正規化レコード。取り込み対象外なら null */
export type Normalizer = (record: Record<string, unknown>) => NormalizedRecord | null;

export interface NormalizerConfig {
  /** プロバイダに要求するデータモデル名（例: "messages", "emails"） */
  model: string;
  /** 保存時の source_type（省略時は integrationId をそのまま使用） */
  sourceType?: string;
  normalize: Normalizer;
}

// ─── 例: 移植したノーマライザ3種 ─────────────────────────────────────────────

/** Slack/Teams系メッセージ（元: transformSlackMessage） */
export function normalizeChatMessage(r: Record<string, unknown>): NormalizedRecord | null {
  const text = String(r.text || r.message || "");
  if (!text) return null;
  return {
    scope_id: "",
    title: `Slack: ${String(r.channel || r.channel_name || "DM")}`,
    source_type: "slack",
    content: `[${String(r.user || r.user_name || "unknown")}] ${text}`,
    external_id: String(r.ts || r.id || ""),
    metadata: { channel: r.channel, user: r.user, ts: r.ts },
  };
}

/** Gmail/Outlook系メール（元: transformEmail） */
export function normalizeEmail(r: Record<string, unknown>): NormalizedRecord | null {
  const subject = String(r.subject || r.title || "");
  const body = String(r.body || r.snippet || r.text || "");
  if (!subject && !body) return null;
  return {
    scope_id: "",
    title: subject || "No Subject",
    source_type: "gmail",
    content: body.substring(0, 5000),
    external_id: String(r.id || r.message_id || ""),
    metadata: { from: r.from, to: r.to, date: r.date },
  };
}

/** GA4レポート行（元: transformGa4Report） */
export function normalizeGa4Report(r: Record<string, unknown>): NormalizedRecord | null {
  return {
    scope_id: "",
    title: String(r.page_path ?? r.event_name ?? "unknown"),
    source_type: "analytics",
    content: JSON.stringify({
      sessions: r.sessions ?? 0,
      pageviews: r.pageviews ?? r.screen_page_views ?? 0,
      users: r.users ?? r.active_users ?? 0,
      conversions: r.conversions ?? 0,
      bounce_rate: r.bounce_rate ?? 0,
    }),
    external_id: `ga4_${r.page_path ?? r.event_name}_${r.date ?? ""}`,
  };
}

/** 汎用フォールバック（元: transformGeneric）。title/content が拾えなければ null */
export function normalizeGeneric(r: Record<string, unknown>): NormalizedRecord | null {
  const title = String(r.title || r.name || r.subject || r.summary || "");
  const content = String(r.content || r.body || r.text || r.description || "");
  if (!title && !content) return null;
  return {
    scope_id: "",
    title: title || "Untitled",
    source_type: "",
    content: content.substring(0, 5000),
    external_id: String(r.id || ""),
  };
}

// ─── レジストリ ──────────────────────────────────────────────────────────────

const GENERIC_CONFIG: Required<Pick<NormalizerConfig, "model" | "normalize">> &
  NormalizerConfig = {
  model: "records",
  normalize: normalizeGeneric,
};

export class NormalizerRegistry {
  private readonly configs = new Map<string, NormalizerConfig>();

  register(integrationId: string, config: NormalizerConfig): this {
    this.configs.set(integrationId, config);
    return this;
  }

  get(integrationId: string): NormalizerConfig | undefined {
    return this.configs.get(integrationId);
  }

  has(integrationId: string): boolean {
    return this.configs.has(integrationId);
  }

  /** 登録済み統合ID一覧 */
  list(): string[] {
    return [...this.configs.keys()];
  }

  /**
   * 統合IDの設定を解決する。未登録なら汎用フォールバック
   * （model: "records" + normalizeGeneric、source_type = integrationId）。
   */
  resolve(integrationId: string): { model: string; sourceType: string; normalize: Normalizer } {
    const config = this.configs.get(integrationId) ?? GENERIC_CONFIG;
    return {
      model: config.model,
      sourceType: config.sourceType || integrationId,
      normalize: config.normalize,
    };
  }
}

/**
 * 例の3ノーマライザを登録したレジストリを作る。
 * 元実装では slack/teams が同じ transform、gmail/outlook が同じ transform を共有していた。
 */
export function createExampleRegistry(): NormalizerRegistry {
  return new NormalizerRegistry()
    .register("slack", { model: "messages", sourceType: "slack", normalize: normalizeChatMessage })
    .register("microsoft-teams", { model: "messages", sourceType: "teams", normalize: normalizeChatMessage })
    .register("google-mail", { model: "emails", sourceType: "gmail", normalize: normalizeEmail })
    .register("outlook", { model: "emails", sourceType: "outlook", normalize: normalizeEmail })
    .register("google-analytics", { model: "reports", sourceType: "analytics", normalize: normalizeGa4Report });
}
