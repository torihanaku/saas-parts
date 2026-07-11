/**
 * Shared types for the Autonomous Deploy Agent.
 *
 * オーケストレーターは承認済み submission に対して各チャネルアダプタを順に実行し、
 * `deploy_log` に `DeployStep` を追記する。後段のステップが失敗したら完了済みの
 * ステップをアダプタの `rollback()` で巻き戻す。
 *
 * 出典: dev-dashboard-v2 server/lib/autonomous-deploy/types.ts
 */

export type DeployTarget = "seo" | "cms" | "sns" | "ad";

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
  /**
   * Free-form structured detail. Adapters set this; rollbacks read from it
   * (e.g. `externalId` to delete).
   */
  detail?: Record<string, unknown>;
  error?: string;
}

export interface SubmissionRecord {
  id: string;
  tenant_id: string;
  title: string;
  content_text: string;
  status: string;
  auto_deploy: boolean;
  deploy_log?: DeployStep[];
}

export interface DeployContext {
  submission: SubmissionRecord;
  /** Channels to attempt this run, in order. */
  targets: DeployTarget[];
  /** Identifier surfaced in audit + notifications. */
  triggeredBy: string;
}

export interface DeployAdapterResult {
  status: "success" | "skipped" | "failed";
  detail?: Record<string, unknown>;
  reason?: string;
}

export interface DeployAdapter {
  readonly target: DeployTarget;
  /** Execute the channel-specific publish. Throws on hard failure. */
  run(submission: SubmissionRecord): Promise<DeployAdapterResult>;
  /**
   * Compensating action invoked when a later step fails. Adapters that
   * cannot meaningfully roll back (e.g. SNS posts already public) should
   * still implement this and log a no-op.
   */
  rollback(submission: SubmissionRecord, step: DeployStep): Promise<void>;
}

export interface OrchestratorRunResult {
  submissionId: string;
  status: "success" | "partial" | "failed" | "skipped";
  steps: DeployStep[];
  reason?: string;
}
