/**
 * 共通型定義 — DORA メトリクス / デプロイ運用 / Git ワークスペース。
 *
 * dev-dashboard-v2 の server/routes/dora, deploy-*, git-workspace,
 * autonomous-deploy から抽出。GitHub / Supabase / Slack への直接依存は
 * すべて注入インターフェース経由に置き換えている。
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Git リポジトリ / ワークフロー実行                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/** 集計対象のリポジトリ。owner/name が API 呼び出しに、label が表示に使われる。 */
export interface RepoRef {
  owner: string;
  name: string;
  label: string;
}

/** GitHub Actions のワークフロー実行（DORA 計算に必要な最小フィールド）。 */
export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  head_branch: string;
  run_number: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* DORA メトリクス                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

export type DoraLevel = "Elite" | "High" | "Medium" | "Low";

/**
 * DORA 4 指標。フロントエンドの DoraMetricsData インターフェースと一致。
 * avgHours ~ medianHours ~ p90Hours は近似（Actions からは平均のみ取得可能。
 * 真のパーセンタイルには PR 単位のデータが要る）。
 */
export interface DoraMetrics {
  deploymentFrequency: { daily: number; weekly: number; monthly: number; trend: number[] };
  leadTimeForChanges: { avgHours: number; medianHours: number; p90Hours: number; trend: number[] };
  changeFailureRate: { rate: number; totalDeploys: number; failures: number; trend: number[] };
  mttr: { avgHours: number; medianHours: number; incidents: number };
  period: string;
  repoBreakdown: Array<{ repo: string; deployFreq: number; failRate: number; avgLeadTime: number }>;
  weeklyTrend: Array<{ week: string; deployments: number; failures: number; avgLeadTime: number }>;
  level: DoraLevel;
  updatedAt: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* デプロイ健全性                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export type DeployStatus = "healthy" | "degraded" | "critical";
export type CheckStatus = "healthy" | "warning" | "critical";
export type OverallStatus = "healthy" | "warning" | "critical";

export interface DeployReachResult {
  repo: string;
  period_days: number;
  merged_prs: number;
  releases: number;
  reach_rate: number;
  latest_release: { tag: string; published_at: string } | null;
  status: DeployStatus;
}

/** サイレント障害チェックの1項目の設定。 */
export interface SilentFailureCheckConfig {
  name: string;
  threshold_hours: number;
  description: string;
}

export interface SilentFailureCheck {
  name: string;
  status: CheckStatus;
  last_activity: string | null;
  hours_since: number | null;
  threshold_hours: number;
  description: string;
}

export interface SilentFailuresResult {
  checks: SilentFailureCheck[];
  overall_status: OverallStatus;
  critical_count: number;
  warning_count: number;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* デプロイオーケストレーション                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * デプロイ対象チャンネル。元実装は "seo" | "cms" | "sns" | "ad" 固定だったが、
 * 任意の文字列を許容して汎用化した（レジストリのキーで検証する）。
 */
export type DeployTarget = string;

export type DeployStepStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped"
  | "rolled_back";

export interface DeployStep {
  target: DeployTarget;
  status: DeployStepStatus;
  startedAt: string;
  finishedAt?: string;
  /** アダプタが書き込む自由形式の詳細。ロールバック時に読む（例: 削除用 externalId）。 */
  detail?: Record<string, unknown>;
  error?: string;
}

export interface SubmissionRecord {
  id: string;
  tenantId: string;
  title: string;
  contentText: string;
  status: string;
  autoDeploy: boolean;
  deployLog?: DeployStep[];
}

export interface DeployAdapterResult {
  status: "success" | "skipped" | "failed";
  detail?: Record<string, unknown>;
  reason?: string;
}

/** チャンネル固有の公開処理。マーケ用アダプタ実装はキットに含めず、注入する。 */
export interface DeployAdapter {
  readonly target: DeployTarget;
  /** チャンネル固有の公開を実行。ハード失敗時は throw。 */
  run(submission: SubmissionRecord): Promise<DeployAdapterResult>;
  /** 後続ステップが失敗したときの補償処理。 */
  rollback(submission: SubmissionRecord, step: DeployStep): Promise<void>;
}

export interface OrchestratorRunResult {
  submissionId: string;
  status: "success" | "partial" | "failed" | "skipped";
  steps: DeployStep[];
  reason?: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Git ワークスペース                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

export interface GitFileStatus {
  code: string; // 'M', 'A', 'D', '??', 'R' など
  path: string;
}

export interface GitWorkspaceState {
  repo: string;
  repoPath: string;
  branch: string;
  lastCommit: string;
  files: GitFileStatus[];
  updatedAt: string;
}
