export * from "./navigator-signals";

export interface UseCaseCard {
  source: {
    kind: 'trending_repo' | 'product_launch' | 'vc_thesis' | 'stack_advice' | 'failure_pattern' | 'manual';
    title: string;
    url?: string;
    summary: string;
    capturedAt: string;
  };
  tool: {
    kind: 'saas' | 'library' | 'pattern' | 'stack';
    name: string;
    vendor?: string;
    homepageUrl?: string;
  };
  integration: {
    bridgeType: 'api' | 'webhook' | 'cli' | 'prompt' | 'manual';
    notes: string;
    prerequisiteLibs?: string[];
  };
  output: {
    kind: 'github_issue' | 'x_post' | 'internal_note' | 'architecture_change' | 'experiment_spec';
    draftText: string;
    targetRepo?: string;
  };
  meta: {
    importanceScore: number;
    rationale: string;
    generatedBy: 'opus' | 'haiku' | 'hybrid';
    sourceVersion: 'v1';
    github_issue_id?: number;
  };
}

export interface BriefItem {
  signalId: string;
  title: string;
  verdict: 'big_deal' | 'worth_watching' | 'meh';
  importanceScore: number;
  rationale: string;
  proposedCardTitle: string;
}

// 21 カテゴリ。 migration 20260419_001 の CHECK 制約と一致させること
export type StackCategory =
  | 'runtime' | 'db' | 'auth'
  | 'email_tx' | 'email_ma' | 'payment'
  | 'storage_cdn' | 'monitoring' | 'search'
  | 'ai_llm' | 'vector_db' | 'queue'
  | 'form' | 'no_code' | 'integration'
  | 'crm' | 'support' | 'feature_flag'
  | 'cms' | 'real_time' | 'dns_domain'
  | 'sms_voice' | 'push' | 'ai_media'
  | 'cache' | 'secret';

export interface Stack {
  id: string;
  slug: string;
  category: StackCategory;
  name: string;
  vendor: string;
  description: string;
  pricingUrl: string;
  docsUrl: string;
  pros: string[];
  cons: string[];
  typicalCostUsdPerMonth?: Record<string, number>;
  /** AI ドラフトを未レビューの場合 true (公式 docs ベースだが実体験未確認の合図) */
  isDraft?: boolean;
  updatedAt: string;
}

export interface FailurePattern {
  id: string;
  stackId?: string;
  title: string;
  summary: string;
  rootCause?: string;
  mitigation?: string;
  sourceUrl?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
}

export interface StackRecommendation {
  primary: { stack: Stack; reasons: string[]; migrationCostJpyPerMonth?: number; migrationEffortDays?: number };
  alternative: { stack: Stack; reasons: string[] };
  unnecessary?: string[];
  warnings: FailurePattern[];
  docs: string[];
}

export interface Signal {
  id: string;
  userId: string;
  source: 'hn' | 'x' | 'product_hunt' | 'github_trending' | 'vc' | 'manual';
  sourceRef: string;
  url: string;
  title: string;
  body?: string;
  rawJson?: Record<string, unknown>;
  fetchedAt: string;
  seenAt?: string;
  createdAt: string;
}

export interface Context {
  id: string;
  userId: string;
  signalId: string;
  relatedSignalIds: string[];
  importanceScore: number;
  verdict: 'big_deal' | 'worth_watching' | 'meh';
  rationale: string;
  createdAt: string;
}

export type CardStatus = 'draft' | 'testing' | 'validated' | 'invalidated' | 'rejected';

export interface HypothesisFields {
  hypothesis?: string;
  assumption?: string;
  testPlan?: string;
  invalidationCriteria?: string;
}

export interface Card extends HypothesisFields {
  id: string;
  userId: string;
  projectId?: string;
  triggerSource: 'f1_signal' | 'f2_stack' | 'manual';
  triggerSignalId?: string;
  triggerStackId?: string;
  title: string;
  summary: string;
  cardData: UseCaseCard;
  status: CardStatus;
  createdAt: string;
  updatedAt: string;
}

// 新規: 学び
export interface CardLearning {
  id: string;
  cardId: string;
  userId: string;
  learning: string;
  outcome?: 'validated' | 'invalidated' | 'neutral';
  createdAt: string;
}

export interface Action {
  id: string;
  userId: string;
  cardId: string;
  actionType: 'github_issue' | 'x_draft' | 'reject' | 'saved_for_later';
  payload: Record<string, unknown>;
  createdAt: string;
}

// API Requests/Responses
export interface GetBriefRequest {
  date?: string;
  limit?: number;
}
export interface GetBriefResponse {
  items: BriefItem[];
}

export interface FetchSignalsRequest {
  sources: string[];
}
export interface FetchSignalsResponse {
  fetched: number;
  skipped: number;
}

export interface GetSignalResponse {
  signal: Signal;
  context: Context;
}

export interface CreateCardRequest {
  triggerSource: 'f1_signal' | 'f2_stack' | 'manual';
  triggerSignalId?: string;
  triggerStackId?: string;
  rawInput?: string;
  title?: string;
  summary?: string;
  hypothesis?: string;
  assumption?: string;
  testPlan?: string;
  invalidationCriteria?: string;
}
export interface CreateCardResponse {
  card: Card;
}

export interface GetCardsRequest {
  status?: CardStatus;
  limit?: number;
  cursor?: string;
}
export interface GetCardsResponse {
  items: Card[];
  nextCursor?: string;
}

export interface GetCardResponse {
  card: Card;
  actions: Action[];
  learnings?: CardLearning[];
}

export interface CardActionRequest {
  actionType: 'github_issue' | 'x_draft' | 'reject' | 'saved_for_later';
  payload: Record<string, unknown>;
}
export interface CardActionResponse {
  action: Action;
}

export interface StackAdvisorQueryRequest {
  currentStack: string;
  scale: string;
  pains: string;
}
export interface StackAdvisorQueryResponse {
  recommendations: StackRecommendation[];
}

export interface GetStacksRequest {
  category?: string;
}
export interface GetStacksResponse {
  items: Stack[];
}

export interface GetFailurePatternsRequest {
  stackId?: string;
  severity?: string;
}
export interface GetFailurePatternsResponse {
  items: FailurePattern[];
}
