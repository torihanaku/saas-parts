/**
 * SNS 炎上監視の共通型と注入インターフェース。
 *
 * 原典 dev-dashboard-v2 は Reddit にハードコードされていたが、ここでは
 * `CrisisSource` 注入 IF に一般化し、Reddit をその一例として同梱する。
 */

// ─── Mention / Source ────────────────────────────────────────────────────────

/** 監視ソースから取得した 1 件の言及。 */
export interface CrisisMention {
  /** ソース内でユニークな ID（例: "reddit:abc"）。 */
  external_id: string;
  /** 本文（タイトル＋本文など、分析対象テキスト）。 */
  content: string;
  /** 元投稿への URL（任意）。 */
  permalink?: string;
  /** 追加メタデータ（subreddit, author, created_utc など）。 */
  metadata?: Record<string, unknown>;
}

export interface CrisisSearchOptions {
  limit?: number;
  time?: "hour" | "day" | "week" | "month" | "year" | "all";
  sort?: "relevance" | "new" | "hot" | "top";
}

/**
 * 監視ソースの抽象。Reddit / X / ニュース等はこれを実装する。
 * `search` はエラー時に throw せず `[]` を返すこと（graceful degradation）が望ましい。
 */
export interface CrisisSource {
  /** ソース名（保存される mention の source フィールドに使う）。 */
  readonly name: string;
  search(keyword: string, options?: CrisisSearchOptions): Promise<CrisisMention[]>;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

/** 保存済みの言及レコード。 */
export interface BrandMention {
  id?: string;
  tenant_id: string;
  source: string;
  external_id: string;
  content: string;
  sentiment: string;
  fetched_at: string;
}

/** 監視キーワード（テナント単位）。 */
export interface MonitoredKeyword {
  id: string;
  tenant_id: string;
  keyword: string;
}

/** 炎上アラート。 */
export interface BrandCrisisAlert {
  tenant_id: string;
  alert_type: string;
  mention_count: number;
  threshold: number;
  triggered_at: string;
  notified_channels: string[];
}

/**
 * 永続化の抽象（原典 dd_ai_visibility_queries / dd_brand_mentions /
 * dd_brand_crisis_alerts に対応）。in-memory 実装を同梱。
 */
export interface CrisisStore {
  /** 監視対象キーワード（有効なもの）を全テナント分返す。 */
  getMonitoredKeywords(): Promise<MonitoredKeyword[]>;
  /** 言及を 1 件保存。 */
  insertMention(mention: BrandMention): Promise<void>;
  /** テナントの直近言及数を返す（sinceIso 以降）。 */
  countRecentMentions(tenantId: string, sinceIso: string): Promise<number>;
  /** アラートを保存。 */
  insertAlert(alert: BrandCrisisAlert): Promise<void>;
}

// ─── Injected callbacks ──────────────────────────────────────────────────────

/** LLM 構造化 JSON 生成（@torihanaku/claude-api の generateJson 互換）。 */
export type GenerateJson = <T>(
  apiKey: string,
  system: string,
  userPrompt: string,
  fallback: T,
  options?: { maxTokens?: number; model?: string; timeout?: number },
) => Promise<T>;

/** API キー解決（tenant secret → env fallback を注入式に）。省略時は空文字。 */
export type ResolveApiKey = (tenantId: string) => Promise<string> | string;

/** アラート通知（Slack 等）。省略時は no-op。throw しても本体は握る。 */
export type Alerter = (params: {
  tenantId: string;
  alertType: string;
  count: number;
  threshold: number;
}) => Promise<void> | void;

export type Logger = (level: "warn" | "error" | "info", message: string, detail?: unknown) => void;

// ─── Config ──────────────────────────────────────────────────────────────────

export interface BrandCrisisConfig {
  /** 監視ソース（1 つ以上）。Reddit 等。 */
  sources: CrisisSource[];
  store: CrisisStore;
  generateJson: GenerateJson;
  /** API キー解決。省略時は常に空文字 → 感情分類は fallback("neutral")。 */
  resolveApiKey?: ResolveApiKey;
  /** アラート通知。省略時は no-op。 */
  alerter?: Alerter;
  /** スパイク判定の閾値（原典 = 10）。 */
  threshold?: number;
  /** ソース検索時の options（原典 = { limit: 25, sort: "new", time: "day" }）。 */
  searchOptions?: CrisisSearchOptions;
  /** 感情分類に使う LLM モデル（原典 = claude-3-haiku-20240307）。 */
  sentimentModel?: string;
  logger?: Logger;
}

export const DEFAULT_THRESHOLD = 10;
export const DEFAULT_SEARCH_OPTIONS: CrisisSearchOptions = { limit: 25, sort: "new", time: "day" };
export const DEFAULT_SENTIMENT_MODEL = "claude-3-haiku-20240307";
