/**
 * デプロイオーケストレーションコア。
 *
 * 承認済み submission を読み、注入されたアダプタレジストリを順に walk し、
 * 各試行の DeployStep を deploy_log に追記する。いずれかのステップがハード失敗
 * したら、成功済みステップをアダプタの rollback() で逆順に巻き戻す。
 *
 * 実運用SaaS server/lib/autonomous-deploy/orchestrator.ts から抽出。
 * Supabase 永続化 → SubmissionStore、監査ログ → AuditLogger コールバック、
 * Slack 通知 → DeployNotifier コールバックに置き換え、マーケ用チャンネルアダプタ
 * 実装（seo/cms/sns/ad）はキットに含めず注入する。
 */
import type {
  DeployAdapter,
  DeployStep,
  DeployTarget,
  OrchestratorRunResult,
  SubmissionRecord,
} from "./types.js";

/** submission の読み取りと deploy_log 永続化を抽象化するポート。 */
export interface SubmissionStore {
  getById(submissionId: string): Promise<SubmissionRecord | null>;
  /** マージ済みの deploy_log を永続化する。 */
  updateDeployLog(submissionId: string, deployLog: DeployStep[]): Promise<void>;
}

/** 監査ログのコールバック（Slack / DB / 何もしない、を注入で選べる）。 */
export type AuditLogger = (entry: {
  tenantId: string;
  submissionId: string;
  triggeredBy: string;
  status: OrchestratorRunResult["status"];
  failedTarget: DeployTarget | null;
  failureMessage?: string;
  steps: Array<{ target: DeployTarget; status: DeployStep["status"] }>;
}) => Promise<void> | void;

/** デプロイ結果通知のコールバック（例: Slack 投稿）。 */
export type DeployNotifier = (result: OrchestratorRunResult) => Promise<void> | void;

export interface RunAutonomousDeployOptions {
  triggeredBy?: string;
  targets?: DeployTarget[];
  /**
   * true のとき autonomousDeploy フラグと auto_deploy マーカーを無視する
   * （管理者の手動トリガー用）。既定 false。
   */
  force?: boolean;
}

export interface OrchestratorDeps {
  store: SubmissionStore;
  /** DeployTarget → アダプタ。マーケ用アダプタはここに注入する。 */
  registry: Record<DeployTarget, DeployAdapter>;
  /** 実行順の既定 target 列。未指定なら registry のキー順。 */
  defaultTargets?: DeployTarget[];
  /** force=false のときに参照する機能フラグ。未指定なら常に有効。 */
  isFeatureEnabled?: () => boolean;
  audit?: AuditLogger;
  notify?: DeployNotifier;
}

export async function runAutonomousDeploy(
  submissionId: string,
  deps: OrchestratorDeps,
  options: RunAutonomousDeployOptions = {},
): Promise<OrchestratorRunResult> {
  const triggeredBy = options.triggeredBy ?? "system";
  const featureEnabled = deps.isFeatureEnabled ? deps.isFeatureEnabled() : true;

  if (!options.force && !featureEnabled) {
    return { submissionId, status: "skipped", steps: [], reason: "feature_flag_disabled" };
  }

  const submission = await deps.store.getById(submissionId);
  if (!submission) {
    throw new Error(`submission_not_found: ${submissionId}`);
  }

  if (submission.status !== "approved") {
    return {
      submissionId,
      status: "skipped",
      steps: [],
      reason: `submission_status_not_approved: ${submission.status}`,
    };
  }

  if (!options.force && !submission.autoDeploy) {
    return { submissionId, status: "skipped", steps: [], reason: "auto_deploy_not_opted_in" };
  }

  const targets = options.targets ?? deps.defaultTargets ?? Object.keys(deps.registry);
  const completedSteps: DeployStep[] = [];
  const allSteps: DeployStep[] = [];
  let failedTarget: DeployTarget | null = null;
  let failureMessage: string | undefined;

  for (const target of targets) {
    const adapter = deps.registry[target];
    const startedAt = new Date().toISOString();
    const step: DeployStep = { target, status: "running", startedAt };

    if (!adapter) {
      step.status = "skipped";
      step.error = `no_adapter_for_target: ${target}`;
      step.finishedAt = new Date().toISOString();
      allSteps.push(step);
      continue;
    }

    try {
      const result = await adapter.run(submission);
      step.status = result.status === "success" ? "success" : "skipped";
      step.detail = result.detail;
      step.finishedAt = new Date().toISOString();
      if (result.status === "skipped") {
        step.error = result.reason;
      }
      allSteps.push(step);
      if (result.status === "success") {
        completedSteps.push(step);
      }
    } catch (err) {
      step.status = "failed";
      step.error = err instanceof Error ? err.message : String(err);
      step.finishedAt = new Date().toISOString();
      allSteps.push(step);
      failedTarget = target;
      failureMessage = step.error;
      break;
    }
  }

  if (failedTarget) {
    for (const completed of completedSteps.reverse()) {
      try {
        await deps.registry[completed.target]!.rollback(submission, completed);
        completed.status = "rolled_back";
      } catch (err) {
        completed.error = `rollback_failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  await persistDeployLog(deps.store, submissionId, submission, allSteps);

  const overallStatus: OrchestratorRunResult["status"] = failedTarget
    ? "failed"
    : allSteps.some((s) => s.status === "success")
      ? "success"
      : "partial";

  if (deps.audit) {
    await deps.audit({
      tenantId: submission.tenantId,
      submissionId,
      triggeredBy,
      status: overallStatus,
      failedTarget,
      failureMessage,
      steps: allSteps.map((s) => ({ target: s.target, status: s.status })),
    });
  }

  const result: OrchestratorRunResult = {
    submissionId,
    status: overallStatus,
    steps: allSteps,
    reason: failureMessage,
  };

  if (deps.notify) {
    await deps.notify(result);
  }

  return result;
}

async function persistDeployLog(
  store: SubmissionStore,
  submissionId: string,
  submission: SubmissionRecord,
  newSteps: DeployStep[],
): Promise<void> {
  const existing = Array.isArray(submission.deployLog) ? submission.deployLog : [];
  const merged = [...existing, ...newSteps];
  await store.updateDeployLog(submissionId, merged);
}
