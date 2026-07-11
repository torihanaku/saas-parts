/**
 * 抽出タスクの外部バックログ同期（元: server/lib/cos/task-sync.ts, COS-3）。
 *
 * 同期先は `TaskSyncTarget` インターフェースで抽象化し、参考実装として
 * GitHub Issues / Linear の 2 つを同梱する。どちらも「クレデンシャル未設定なら
 * fail-closed」— 実在する外部 issue なしにタスクを synced にしないため。
 *
 * 純関数 + 明示的 config（env 読み取りなし）なのでテストが容易。
 */
import { createLinearIssue } from "./linear-client";
import type { FetchLike } from "./types";

export interface TaskSyncContext {
  id: string;
  tenantId: string;
  taskText: string;
  assigneeHint: string | null;
  dueHint: string | null;
}

export interface SyncSuccess {
  ok: true;
  externalId: string;
  externalUrl: string | null;
}
export interface SyncFailure {
  ok: false;
  error: string;
}
export type SyncOutcome = SyncSuccess | SyncFailure;

/**
 * 同期先の注入点。GitHub / Linear 以外（Jira, Asana, Notion...）は
 * このインターフェースを実装して TaskReviewService に登録する。
 */
export interface TaskSyncTarget {
  /** タスクの status カラムに記録されるラベル（例: "github_issue"） */
  readonly syncedToLabel: string;
  sync(task: TaskSyncContext): Promise<SyncOutcome>;
}

export const DEFAULT_PRODUCT_NAME = "AI Chief of Staff";

/** issue 本文の共通フォーマット。productName でインポート元表記をパラメータ化。 */
export function buildIssueBody(
  task: TaskSyncContext,
  productName = DEFAULT_PRODUCT_NAME,
): string {
  return [
    `_Imported from ${productName}._`,
    "",
    `**Task**: ${task.taskText}`,
    task.assigneeHint ? `**Assignee hint**: ${task.assigneeHint}` : "",
    task.dueHint ? `**Due hint**: ${task.dueHint}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function issueTitle(task: TaskSyncContext): string {
  return `[COS] ${task.taskText.replace(/\s+/g, " ").trim().slice(0, 80)}`;
}

// ─── GitHub Issues 実装 ───────────────────────────────────────────────────────

export interface GithubSyncConfig {
  token?: string;
  /** "owner/repo" */
  repo?: string;
  productName?: string;
  fetchImpl?: FetchLike;
}

/**
 * GitHub Issues へ同期。成功リターンは「外部システムに issue が実在する」
 * ことを意味するため、クレデンシャルは必須（無ければ integration_not_configured）。
 */
export async function syncTaskToGithub(
  task: TaskSyncContext,
  config: GithubSyncConfig,
): Promise<SyncOutcome> {
  if (!config.token || !config.repo) {
    return { ok: false, error: "integration_not_configured" };
  }
  const fetchImpl = config.fetchImpl ?? fetch;
  const body = buildIssueBody(task, config.productName);

  try {
    const res = await fetchImpl(`https://api.github.com/repos/${config.repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: issueTitle(task),
        body,
        labels: ["cos", "auto-imported", `tenant:${task.tenantId}`],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `github ${res.status} ${text.slice(0, 120)}` };
    }
    const data = (await res.json()) as { number?: number; html_url?: string };
    if (!data.number) {
      return { ok: false, error: "github returned no issue number" };
    }
    return {
      ok: true,
      externalId: String(data.number),
      externalUrl: data.html_url ?? null,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function createGithubSyncTarget(config: GithubSyncConfig): TaskSyncTarget {
  return {
    syncedToLabel: "github_issue",
    sync: (task) => syncTaskToGithub(task, config),
  };
}

// ─── Linear 実装 ─────────────────────────────────────────────────────────────

export interface LinearSyncConfig {
  apiKey?: string;
  teamId?: string;
  productName?: string;
  fetchImpl?: FetchLike;
}

/**
 * Linear GraphQL `IssueCreate` で同期。クレデンシャル未設定は fail-closed。
 */
export async function syncTaskToLinear(
  task: TaskSyncContext,
  config: LinearSyncConfig = {},
): Promise<SyncOutcome> {
  if (!config.apiKey || !config.teamId) {
    return { ok: false, error: "integration_not_configured" };
  }
  const issue = await createLinearIssue(
    {
      apiKey: config.apiKey,
      teamId: config.teamId,
      title: issueTitle(task),
      description: buildIssueBody(task, config.productName),
    },
    config.fetchImpl ?? fetch,
  );
  if (!issue) {
    return { ok: false, error: "linear_create_failed" };
  }
  return { ok: true, externalId: issue.id, externalUrl: issue.url };
}

export function createLinearSyncTarget(config: LinearSyncConfig = {}): TaskSyncTarget {
  return {
    syncedToLabel: "linear",
    sync: (task) => syncTaskToLinear(task, config),
  };
}
