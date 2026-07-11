/**
 * React フック — GitHub のコミット / ワークフロー実行をポーリングする。
 *
 * dev-dashboard-v2 src/hooks/useGitHub.ts から抽出。
 * ハードコードされていた REPOS は引数化し、fetch URL も注入可能にした。
 */
import { useState, useEffect, useCallback } from "react";

export interface ClientRepoRef {
  owner: string;
  name: string;
  label: string;
}

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  repo: string;
}

export interface WorkflowRunView {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  run_number: number;
  repo: string;
}

export interface UseGitHubOptions {
  /** 集計対象リポジトリ。 */
  repos: ClientRepoRef[];
  /** GitHub API プロキシのベースパス。既定 "/github-api"。 */
  apiBase?: string;
  /** ポーリング間隔（ms）。既定 60000。 */
  pollIntervalMs?: number;
  /** 差し替え可能な fetcher（テスト用）。既定はグローバル fetch。 */
  fetchImpl?: typeof fetch;
}

async function fetchJSON<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json() as Promise<T>;
}

/** バックエンドのヘルスチェック。 */
export async function checkBackendHealth(
  url = "/health-check",
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data.status === "ok";
  } catch {
    return false;
  }
}

export function useGitHubCommits(options: UseGitHubOptions) {
  const { repos, apiBase = "/github-api", pollIntervalMs = 60000, fetchImpl = fetch } = options;
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchCommits = useCallback(async () => {
    try {
      const allCommits: GitCommit[] = [];
      for (const repo of repos) {
        try {
          const data = await fetchJSON<
            Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }>
          >(`${apiBase}/repos/${repo.owner}/${repo.name}/commits?per_page=30`, fetchImpl);
          allCommits.push(
            ...data.map((c) => ({
              sha: c.sha,
              message: c.commit.message.split("\n")[0] ?? "",
              author: c.commit.author.name,
              date: c.commit.author.date,
              repo: repo.label,
            })),
          );
        } catch {
          // Skip repos that fail
        }
      }
      allCommits.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setCommits(allCommits.slice(0, 30));
    } catch {
      // fail silently
    } finally {
      setLoading(false);
    }
  }, [repos, apiBase, fetchImpl]);

  useEffect(() => {
    fetchCommits();
    const interval = setInterval(fetchCommits, pollIntervalMs);
    return () => clearInterval(interval);
  }, [fetchCommits, pollIntervalMs]);

  return { commits, loading };
}

export function useGitHubWorkflows(options: UseGitHubOptions) {
  const { repos, apiBase = "/github-api", pollIntervalMs = 60000, fetchImpl = fetch } = options;
  const [runs, setRuns] = useState<WorkflowRunView[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRuns = useCallback(async () => {
    try {
      const allRuns: WorkflowRunView[] = [];
      for (const repo of repos) {
        try {
          const data = await fetchJSON<{
            workflow_runs: Array<{
              id: number;
              name: string;
              status: string;
              conclusion: string | null;
              created_at: string;
              updated_at: string;
              html_url: string;
              run_number: number;
            }>;
          }>(`${apiBase}/repos/${repo.owner}/${repo.name}/actions/runs?per_page=30`, fetchImpl);
          allRuns.push(...data.workflow_runs.map((r) => ({ ...r, repo: repo.label })));
        } catch {
          // Skip repos that fail
        }
      }
      allRuns.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setRuns(allRuns.slice(0, 30));
    } catch {
      // fail silently
    } finally {
      setLoading(false);
    }
  }, [repos, apiBase, fetchImpl]);

  useEffect(() => {
    fetchRuns();
    const interval = setInterval(fetchRuns, pollIntervalMs);
    return () => clearInterval(interval);
  }, [fetchRuns, pollIntervalMs]);

  return { runs, loading };
}
