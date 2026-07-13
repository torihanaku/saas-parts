/**
 * 調査アシスタント (research navigator) のドメイン型。
 *
 * 外部シグナル (ニュース/検索/HN 等) を取り込み、LLM で重要度判定 (verdict) →
 * クラスタ検出 → 仮説カード生成 → アクション実行 → 学び (learning) 記録、
 * という一連のパイプラインで扱うデータを定義する。
 *
 * 出典: 実運用SaaS shared/types/navigator.ts + navigator-signals.ts
 */

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** シグナルの重要度判定。 */
export type Verdict = "big_deal" | "worth_watching" | "meh";

/** 取り込み前のシグナル (ソースが返す生データ)。 */
export interface NewSignal {
  /** ソース識別子 (例: "hackernews", "exa_search", "manual")。自由文字列。 */
  source: string;
  url: string;
  title: string;
  body?: string | null;
  /** ISO 8601 */
  fetchedAt: string;
}

/** 永続化されたシグナル。 */
export interface Signal {
  id: string;
  userId: string;
  source: string;
  url: string;
  title: string;
  body: string | null;
  fetchedAt: string;
  seenAt: string | null;
  createdAt: string;
}

/** シグナルに対する LLM 判定結果 (永続化形)。 */
export interface SignalContext {
  id: string;
  userId: string;
  signalId: string;
  relatedSignalIds: string[];
  /** 0-100 */
  importanceScore: number;
  verdict: Verdict;
  rationale: string;
  createdAt: string;
}

/** verdict エンジンの出力 (永続化前)。 */
export interface ContextVerdict {
  verdict: Verdict;
  rationale: string;
  /** 0-100 */
  importanceScore: number;
  relatedSignalIds: string[];
}

// ---------------------------------------------------------------------------
// Use case card / hypothesis card
// ---------------------------------------------------------------------------

export interface UseCaseCard {
  source: {
    kind:
      | "trending_repo"
      | "product_launch"
      | "vc_thesis"
      | "stack_advice"
      | "failure_pattern"
      | "manual";
    title: string;
    url?: string;
    summary: string;
    capturedAt: string;
  };
  tool: {
    kind: "saas" | "library" | "pattern" | "stack";
    name: string;
    vendor?: string;
    homepageUrl?: string;
  };
  integration: {
    bridgeType: "api" | "webhook" | "cli" | "prompt" | "manual";
    notes: string;
    prerequisiteLibs?: string[];
  };
  output: {
    kind:
      | "issue"
      | "social_post"
      | "internal_note"
      | "architecture_change"
      | "experiment_spec";
    draftText: string;
    targetRepo?: string;
  };
  meta: {
    /** 0-1 (context の importanceScore 0-100 とはスケールが異なるので注意) */
    importanceScore: number;
    rationale: string;
    generatedBy: string;
    sourceVersion: "v1";
    linkedIssueNumber?: number;
  };
}

export type CardStatus =
  | "draft"
  | "testing"
  | "validated"
  | "invalidated"
  | "rejected";

/**
 * カードの生成トリガー。
 * 元実装の 'f1_signal' → 'signal'、'f2_stack' → 'stack' に一般化。
 */
export type CardTriggerSource = "signal" | "stack" | "manual";

export interface HypothesisFields {
  hypothesis?: string;
  assumption?: string;
  testPlan?: string;
  invalidationCriteria?: string;
}

export interface Card extends HypothesisFields {
  id: string;
  userId: string;
  triggerSource: CardTriggerSource;
  triggerSignalId?: string;
  triggerStackId?: string;
  title: string;
  summary: string;
  cardData: UseCaseCard;
  status: CardStatus;
  createdAt: string;
  updatedAt: string;
}

export type LearningOutcome = "validated" | "invalidated" | "neutral";

export interface CardLearning {
  id: string;
  cardId: string;
  userId: string;
  learning: string;
  outcome: LearningOutcome;
  createdAt: string;
}

export type CardActionType =
  | "issue"
  | "social_draft"
  | "reject"
  | "saved_for_later";

export interface CardAction {
  id: string;
  userId: string;
  cardId: string;
  actionType: CardActionType;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** LLM が生成する仮説ドラフト。 */
export interface HypothesisDraft {
  title: string;
  summary: string;
  hypothesis: string;
  assumption: string;
  testPlan: string;
  invalidationCriteria: string;
}

// ---------------------------------------------------------------------------
// Stack advisor
// ---------------------------------------------------------------------------

export interface Stack {
  id: string;
  slug: string;
  /** 例: "db" | "auth" | "monitoring" 等。ドメイン都合で自由に定義できる。 */
  category: string;
  name: string;
  vendor: string;
  description: string;
  pricingUrl: string;
  docsUrl: string;
  pros: string[];
  cons: string[];
  typicalCostUsdPerMonth?: Record<string, number>;
  updatedAt: string;
}

export interface StackMatch extends Stack {
  similarity: number;
}

export type FailureSeverity = "low" | "medium" | "high" | "critical";

export interface FailurePattern {
  id: string;
  stackId?: string;
  title: string;
  summary: string;
  rootCause?: string;
  mitigation?: string;
  sourceUrl?: string;
  severity: FailureSeverity;
  createdAt: string;
}

export interface StackRecommendation {
  primary: {
    stack: Stack;
    reasons: string[];
    migrationCostJpyPerMonth?: number;
    migrationEffortDays?: number;
  };
  alternative: { stack: Stack; reasons: string[] };
  unnecessary?: string[];
  warnings: FailurePattern[];
  docs: string[];
}

// ---------------------------------------------------------------------------
// Weekly brief
// ---------------------------------------------------------------------------

export interface BriefSignalSummary {
  signalId: string;
  source: string;
  url: string;
  title: string;
  verdict: Verdict;
  importanceScore: number;
  rationale: string;
  fetchedAt: string;
}

export interface NavigatorBrief {
  windowStart: string;
  windowEnd: string;
  totals: {
    big_deal: number;
    worth_watching: number;
    meh: number;
    uncategorized: number;
  };
  topSignals: BriefSignalSummary[];
  bySource: { source: string; count: number }[];
}

// ---------------------------------------------------------------------------
// External issues (GitHub 等の課題トラッカーを一般化)
// ---------------------------------------------------------------------------

export interface ExternalIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
}
