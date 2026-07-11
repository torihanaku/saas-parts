/**
 * GitProvider — Git ホスティング（GitHub 等）への読み書きを抽象化するポート。
 *
 * 元実装は GitHub REST API を直接 fetch していた。キットではこのインターフェース
 * のみに依存するので、テストではモック、本番では fetch ベースの既定実装
 * (createGitHubProvider) を差し込める。
 */
import type { WorkflowRun } from "./types.js";

export interface GitCommitSummary {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface GitRelease {
  tag_name: string;
  published_at: string;
  html_url: string;
}

export interface GitPullRequest {
  number: number;
  merged_at: string | null;
  state: string;
}

export interface GitIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  labels: Array<{ name: string }>;
}

export interface ListWorkflowRunsParams {
  owner: string;
  repo: string;
  /** created>=SINCE のフィルタ（YYYY-MM-DD）。 */
  since?: string;
  branch?: string;
  event?: string;
  perPage?: number;
}

export interface GitProvider {
  /** ワークフロー実行一覧。失敗時は空配列を返す（DORA 集計はフェイルソフト）。 */
  listWorkflowRuns(params: ListWorkflowRunsParams): Promise<WorkflowRun[]>;
  /** コミット一覧。 */
  listCommits(owner: string, repo: string, perPage?: number): Promise<GitCommitSummary[]>;
  /** リリース一覧。 */
  listReleases(owner: string, repo: string, perPage?: number): Promise<GitRelease[]>;
  /** クローズ済み PR 一覧（merged 判定に使う）。 */
  listClosedPullRequests(owner: string, repo: string, perPage?: number): Promise<GitPullRequest[]>;
  /** オープン Issue 一覧（PR を除外）。 */
  listOpenIssues(owner: string, repo: string, perPage?: number): Promise<GitIssue[]>;
  /** Issue 作成。 */
  createIssue(
    owner: string,
    repo: string,
    input: { title: string; body?: string; labels?: string[] },
  ): Promise<{ number: number; title: string; html_url: string }>;
  /** ワークフローの workflow_dispatch トリガー。 */
  dispatchWorkflow(owner: string, repo: string, workflowFile: string, ref: string): Promise<void>;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* fetch ベースの既定実装（GitHub REST v3）                                   */
/* ────────────────────────────────────────────────────────────────────────── */

export interface GitHubProviderOptions {
  token?: string;
  apiBase?: string;
  userAgent?: string;
  /** DI 用。既定はグローバル fetch。 */
  fetchImpl?: typeof fetch;
}

const GITHUB_API = "https://api.github.com";

/**
 * GitHub REST API を叩く GitProvider 既定実装（参照用）。
 * トークンは呼び出し側が渡す（プロセス環境変数は参照しない）。
 */
export function createGitHubProvider(options: GitHubProviderOptions = {}): GitProvider {
  const apiBase = options.apiBase ?? GITHUB_API;
  const userAgent = options.userAgent ?? "kit-devops-metrics";
  const doFetch = options.fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": userAgent,
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
  };

  async function getJson<T>(path: string): Promise<T | null> {
    try {
      const res = await doFetch(`${apiBase}${path}`, { headers });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  return {
    async listWorkflowRuns(params) {
      const q = new URLSearchParams();
      if (params.branch) q.set("branch", params.branch);
      if (params.event) q.set("event", params.event);
      q.set("per_page", String(params.perPage ?? 100));
      if (params.since) q.set("created", `>=${params.since}`);
      const data = await getJson<{ workflow_runs: WorkflowRun[] }>(
        `/repos/${params.owner}/${params.repo}/actions/runs?${q.toString()}`,
      );
      return data?.workflow_runs ?? [];
    },

    async listCommits(owner, repo, perPage = 30) {
      const data = await getJson<
        Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }>
      >(`/repos/${owner}/${repo}/commits?per_page=${perPage}`);
      return (data ?? []).map((c) => ({
        sha: c.sha,
        message: c.commit.message.split("\n")[0] ?? "",
        author: c.commit.author.name,
        date: c.commit.author.date,
      }));
    },

    async listReleases(owner, repo, perPage = 10) {
      return (await getJson<GitRelease[]>(`/repos/${owner}/${repo}/releases?per_page=${perPage}`)) ?? [];
    },

    async listClosedPullRequests(owner, repo, perPage = 20) {
      return (
        (await getJson<GitPullRequest[]>(
          `/repos/${owner}/${repo}/pulls?state=closed&per_page=${perPage}`,
        )) ?? []
      );
    },

    async listOpenIssues(owner, repo, perPage = 10) {
      const raw = await getJson<unknown[]>(`/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}`);
      return (raw ?? [])
        .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null && !("pull_request" in i))
        .map((i) => ({
          number: Number(i.number),
          title: String(i.title ?? ""),
          html_url: String(i.html_url ?? ""),
          state: String(i.state ?? "open"),
          labels: Array.isArray(i.labels)
            ? (i.labels as Array<{ name?: unknown }>).map((l) => ({ name: String(l.name ?? "") }))
            : [],
        }));
    },

    async createIssue(owner, repo, input) {
      const res = await doFetch(`${apiBase}/repos/${owner}/${repo}/issues`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels ?? [] }),
      });
      if (!res.ok) throw new Error(`github_create_issue_failed: ${res.status}`);
      const json = (await res.json()) as { number: number; title: string; html_url: string };
      return { number: json.number, title: json.title, html_url: json.html_url };
    },

    async dispatchWorkflow(owner, repo, workflowFile, ref) {
      const res = await doFetch(
        `${apiBase}/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ ref }),
        },
      );
      if (res.status !== 204) throw new Error(`github_dispatch_failed: ${res.status}`);
    },
  };
}
