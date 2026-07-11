/**
 * Autonomous Deploy Agent — Orchestrator.
 *
 * 承認済み submission を読み、設定されたチャネルアダプタを順に実行して各試行を
 * 構造化 `DeployStep` として `deploy_log` に追記する。いずれかのステップが hard
 * failure したら、それまで成功したステップをアダプタの `rollback()` で巻き戻す。
 *
 * 意図的に同期・single-flight。await するか fire-and-forget するかは呼び出し側が決める。
 *
 * 出典: dev-dashboard-v2 server/lib/autonomous-deploy/orchestrator.ts
 *
 * 移植方針:
 * - submission 取得 / deploy_log 永続化（Supabase 直呼び）→ `DeployStore` 注入。
 * - ハードコード ADAPTER_REGISTRY → `adapters` レジストリ注入（例: seo-adapter を同梱）。
 * - `isEnabled("autonomousDeploy")`（feature flag）→ `enabled` 述語注入（省略時 true）。
 * - `logAuditSystem` → `audit` コールバック注入（省略時 no-op）。
 * - Slack（env + fetch）→ `notify` コールバック注入（省略時 no-op）。
 *
 * 承認ゲート: submission.status === "approved" && auto_deploy を確認する原典の
 * ゲートを保持。より高度な承認フローは @torihanaku/kit-approval-workflow が充足する
 * （本パッケージは import しない。README 参照）。
 */

import type {
  DeployAdapter,
  DeployStep,
  DeployTarget,
  OrchestratorRunResult,
  SubmissionRecord,
} from "./types";

const DEFAULT_TARGETS: DeployTarget[] = ["seo", "cms", "sns", "ad"];

/** アダプタレジストリ。target → adapter。設定チャネルのみ登録すればよい。 */
export type AdapterRegistry = Partial<Record<DeployTarget, DeployAdapter>>;

/**
 * submission の取得と deploy_log 永続化の抽象（原典 dd_submissions 相当）。
 */
export interface DeployStore {
  /** submission を取得（無ければ null）。 */
  getSubmission(submissionId: string): Promise<SubmissionRecord | null>;
  /** deploy_log を差し替え保存（呼び出し側は既存 + 新規のマージ済み配列を受け取る）。 */
  saveDeployLog(submissionId: string, mergedLog: DeployStep[]): Promise<void>;
}

/** 監査ログ書き込み。 */
export type AuditFn = (
  tenantId: string,
  entry: {
    action: string;
    resourceType: string;
    resourceId: string;
    riskLevel: "low" | "high";
    changes: Record<string, unknown>;
  },
) => Promise<void> | void;

/** 結果通知（Slack 等）。 */
export type NotifyFn = (params: {
  submissionId: string;
  status: OrchestratorRunResult["status"];
  steps: DeployStep[];
  failureMessage?: string;
}) => Promise<void> | void;

export type Logger = (level: "warn" | "error", message: string, detail?: unknown) => void;

export interface RunAutonomousDeployOptions {
  triggeredBy?: string;
  targets?: DeployTarget[];
  /**
   * When true, bypass the enabled check and the `auto_deploy` marker —
   * used by admin manual-trigger flows. Defaults to false.
   */
  force?: boolean;
}

export interface AutonomousDeployConfig {
  store: DeployStore;
  adapters: AdapterRegistry;
  /** 実行可否（原典 feature flag）。省略時は常に有効。 */
  enabled?: () => boolean;
  audit?: AuditFn;
  notify?: NotifyFn;
  logger?: Logger;
}

export async function runAutonomousDeploy(
  config: AutonomousDeployConfig,
  submissionId: string,
  options: RunAutonomousDeployOptions = {},
): Promise<OrchestratorRunResult> {
  const triggeredBy = options.triggeredBy ?? "system";
  const isEnabled = config.enabled ?? (() => true);
  const log: Logger = config.logger ?? (() => {});

  if (!options.force && !isEnabled()) {
    return {
      submissionId,
      status: "skipped",
      steps: [],
      reason: "feature_flag_disabled",
    };
  }

  const submission = await config.store.getSubmission(submissionId);

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

  if (!options.force && !submission.auto_deploy) {
    return {
      submissionId,
      status: "skipped",
      steps: [],
      reason: "auto_deploy_not_opted_in",
    };
  }

  const targets = options.targets ?? DEFAULT_TARGETS;
  const completedSteps: DeployStep[] = [];
  const allSteps: DeployStep[] = [];
  let failedTarget: DeployTarget | null = null;
  let failureMessage: string | undefined;

  for (const target of targets) {
    const adapter = config.adapters[target];
    const startedAt = new Date().toISOString();
    const step: DeployStep = {
      target,
      status: "running",
      startedAt,
    };

    // 未登録チャネルは truthful に skipped で記録する。
    if (!adapter) {
      step.status = "skipped";
      step.error = "adapter_not_registered";
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
      const adapter = config.adapters[completed.target];
      try {
        await adapter?.rollback(submission, completed);
        completed.status = "rolled_back";
      } catch (err) {
        completed.error = `rollback_failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  await persistDeployLog(config, submissionId, submission, allSteps, log);

  const overallStatus: OrchestratorRunResult["status"] = failedTarget
    ? "failed"
    : allSteps.some((s) => s.status === "success")
      ? "success"
      : "partial";

  if (config.audit) {
    await config.audit(submission.tenant_id, {
      action: overallStatus === "failed" ? "agent_action_rejected" : "agent_action_approved",
      resourceType: "dd_submission",
      resourceId: submissionId,
      riskLevel: overallStatus === "failed" ? "high" : "low",
      changes: {
        autonomous_deploy_status: overallStatus,
        triggered_by: triggeredBy,
        failed_target: failedTarget,
        failure_message: failureMessage,
        steps: allSteps.map((s) => ({ target: s.target, status: s.status })),
      },
    });
  }

  if (config.notify) {
    try {
      await config.notify({ submissionId, status: overallStatus, steps: allSteps, failureMessage });
    } catch (err) {
      log("warn", "autonomous_deploy_notify_failed", err);
    }
  }

  return {
    submissionId,
    status: overallStatus,
    steps: allSteps,
    reason: failureMessage,
  };
}

async function persistDeployLog(
  config: AutonomousDeployConfig,
  submissionId: string,
  submission: SubmissionRecord,
  newSteps: DeployStep[],
  log: Logger,
): Promise<void> {
  const existing = Array.isArray(submission.deploy_log) ? submission.deploy_log : [];
  const merged = [...existing, ...newSteps];
  try {
    await config.store.saveDeployLog(submissionId, merged);
  } catch (err) {
    log("error", "autonomous_deploy_log_persist_failed", err);
  }
}
