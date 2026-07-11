/**
 * @torihanaku/asset-debt-scanner — 共有型
 *
 * 「資産の劣化を巡回スキャンして修繕提案する」フレームワークの中核型。
 * 出典: dev-dashboard-v2 の Marketing Debt Tracker (#355)。ドメイン用語 (marketing debt /
 * freshness / 6 asset 種別) はマーケ由来だが config で差し替え可能。
 */

/**
 * asset 種別。原文は 6 種の union だったが、汎用フレームワークとして string に緩和。
 * 既定のドメイン語 (content/persona/campaign/link/seo_article/crm_data) は
 * `DEFAULT_ASSET_TYPES` として保持。
 */
export type AssetType = string;

/** Severity バッジ (UI 配色 + 通知優先度)。 */
export type DebtSeverity = "low" | "med" | "high";

/** マーケ由来の既定 asset 種別。 */
export const DEFAULT_ASSET_TYPES = [
  "content",
  "persona",
  "campaign",
  "link",
  "seo_article",
  "crm_data",
] as const;

/** Scoring 関数の入力 (6 種別共通の最小フィールド)。 */
export interface DebtScoringInput {
  tenantId: string;
  assetType: AssetType;
  assetRef: string;
  /** 最終アクティブ時刻 (ISO8601) — 鮮度計算の起点。 */
  lastActiveAt?: string | null;
  /** asset 種別固有のメタデータ (CV 数 / 順位 / バウンス率 等)。 */
  metadata?: Record<string, unknown>;
}

/** Scoring 関数の出力。 */
export interface DebtScoringResult {
  freshnessScore: number;
  decayRate: number;
  severity: DebtSeverity;
  recommendation: string | null;
}

/**
 * スキャナが検出した 1 件の負債レコード。
 * dev-dashboard-v2 の `dd_marketing_debt_items` upsert ペイロードに対応する中立形。
 */
export interface DebtRecord {
  tenantId: string;
  assetType: AssetType;
  assetRef: string;
  freshnessScore: number;
  decayRate: number;
  severity: DebtSeverity;
  recommendation: string | null;
  lastActiveAt?: string | null;
  detectedAt?: string;
}

/**
 * 負債レコードの永続化 (注入式)。
 *
 * dev-dashboard-v2 では `dd_marketing_debt_items` への
 * upsert(onConflict: tenant_id,asset_type,asset_ref) だった。
 * 記録できた件数を返す (失敗分は数えない)。
 */
export type DebtStore = (records: DebtRecord[]) => Promise<number>;

/** スキャナ実行コンテキスト (全スキャナ共通の注入物)。 */
export interface ScanContext {
  /** 検出レコードの永続化。省略時は保存せず recorded=0。 */
  store?: DebtStore;
  /** "now" の上書き (決定的テスト用)。 */
  now?: Date;
  /** 外部 HTTP プローブ用 fetch (dead-link / image スキャナが使用)。 */
  fetchImpl?: typeof fetch;
}

/** 全スキャナ共通のサマリ基底。 */
export interface ScanSummaryBase {
  scanned: number;
  recorded: number;
}
