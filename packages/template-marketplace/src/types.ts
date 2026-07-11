/**
 * Template Marketplace shared types.
 * Ported from dev-dashboard-v2 `shared/types/marketplace.ts`.
 *
 * 匿名化原則: 企業名・具体的な絶対数値は anonymized_pattern / success_signals に
 * 一切残さない。 構成 (subject pattern、 channel mix、 timing、 比率) のみ。
 */

/** 施策タイプ — 何を作ったキャンペーンか */
export type MarketplaceCampaignType =
  | "email"
  | "lp"
  | "ad"
  | "content"
  | "social"
  | "event"
  | "other";

/** ゴール — 何を達成したかったか */
export type MarketplaceGoal =
  | "awareness"
  | "lead_gen"
  | "cvr"
  | "retention"
  | "expansion"
  | "other";

/** Template ステータス */
export type MarketplaceTemplateStatus = "draft" | "published" | "archived";

/** Clone レコードのステータス */
export type MarketplaceCloneStatus = "cloned" | "applied" | "dropped";

/**
 * 匿名化済み構成データ。 企業名・具体数値を含めてはいけない。
 * 例: { subjectPattern: "{benefit}を{timeframe}で実現", channels: ["email","retargeting"] }
 */
export interface AnonymizedPattern {
  /** 件名・コピーのテンプレート (placeholder で抽象化) */
  subjectPattern?: string;
  /** チャネル mix */
  channels?: string[];
  /** タイミング (相対指定。 ローンチ後 N 日 等) */
  timing?: string[];
  /** 構成要素 (CTA、 social proof、 価格表示順 等) */
  components?: string[];
  /** トーン・温度感 */
  tone?: string;
  /** 任意の補足構造 */
  extras?: Record<string, unknown>;
}

/**
 * 成功シグナル — 相対値のみ (絶対 KPI は除去)。
 * 例: { ctrLift: "≥1.5x baseline", cvrRange: "high" }
 */
export interface SuccessSignals {
  ctrLift?: string;
  cvrRange?: string;
  engagementShape?: string;
  durabilityDays?: number;
  notes?: string;
}

/** Marketplace template (DB row 1:1) */
export interface MarketplaceTemplate {
  id: string;
  tenantId: string;
  submittedBy: string | null;
  title: string;
  description: string | null;
  industry: string | null;
  campaignType: MarketplaceCampaignType;
  goal: MarketplaceGoal | null;
  anonymizedPattern: AnonymizedPattern;
  successSignals: SuccessSignals;
  tags: string[];
  status: MarketplaceTemplateStatus;
  published: boolean;
  cloneCount: number;
  reviewCount: number;
  avgRating: number | null;
  createdAt: string;
  updatedAt: string;
}

/** submitTemplate() 入力 */
export interface SubmitTemplateInput {
  title: string;
  description?: string;
  industry?: string;
  campaignType: MarketplaceCampaignType;
  goal?: MarketplaceGoal;
  /** 元キャンペーンの生データ。 service が anonymize する */
  rawSource: Record<string, unknown>;
  tags?: string[];
  /** true なら即 published。 false なら draft */
  publish?: boolean;
}

/** listMarketplace() フィルタ */
export interface ListMarketplaceFilters {
  industry?: string;
  campaignType?: MarketplaceCampaignType;
  goal?: MarketplaceGoal;
  search?: string;
  limit?: number;
}

/** Review row */
export interface MarketplaceReview {
  id: string;
  templateId: string;
  tenantId: string;
  reviewerUserId: string | null;
  rating: number;
  comment: string | null;
  outcomeSummary: Record<string, unknown>;
  createdAt: string;
}

/** addReview() 入力 */
export interface AddReviewInput {
  templateId: string;
  rating: number;
  comment?: string;
  outcomeSummary?: Record<string, unknown>;
}

/** Clone row */
export interface MarketplaceClone {
  id: string;
  templateId: string;
  tenantId: string;
  clonedBy: string | null;
  customizations: Record<string, unknown>;
  status: MarketplaceCloneStatus;
  createdAt: string;
}

/** cloneTemplate() 入力 */
export interface CloneTemplateInput {
  templateId: string;
  customizations?: Record<string, unknown>;
}

// ─── Row types (snake_case, mirrors the original Supabase rows) ──────────────

export interface TemplateRow {
  id: string;
  tenant_id: string;
  submitted_by: string | null;
  title: string;
  description: string | null;
  industry: string | null;
  campaign_type: string;
  goal: string | null;
  anonymized_pattern: AnonymizedPattern;
  success_signals: SuccessSignals;
  tags: string[] | null;
  status: string;
  published: boolean;
  clone_count: number;
  review_count: number;
  avg_rating: number | string | null;
  /** Extractor dedup key (nullable for manually submitted rows). */
  pattern_hash?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateRatingRow {
  template_id: string;
  avg_rating: number | string | null;
  review_count: number | string | null;
  clone_count: number | string | null;
}

export interface ReviewRow {
  id: string;
  template_id: string;
  tenant_id: string;
  reviewer_user_id: string | null;
  rating: number;
  comment: string | null;
  outcome_summary: Record<string, unknown> | null;
  created_at: string;
}

export interface CloneRow {
  id: string;
  template_id: string;
  tenant_id: string;
  cloned_by: string | null;
  customizations: Record<string, unknown> | null;
  status: string;
  created_at: string;
}

export interface ReviewSummary {
  templateId: string;
  count: number;
  average: number;
  /** Histogram keyed 1..5; missing buckets reported as 0. */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}
