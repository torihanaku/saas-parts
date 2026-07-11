/**
 * Git ワークスペース — Claude Code hook 等から git status を受け取り、最新状態を
 * 保持する。dev-dashboard-v2 server/routes/git-workspace.ts から抽出。
 * ルートハンドラ（Request/Response）は外し、パース＋インメモリ store のみを提供。
 */
import type { GitFileStatus, GitWorkspaceState } from "./types.js";

/** git status --porcelain の生出力を GitFileStatus[] にパースする。 */
export function parsePorcelain(raw: string): GitFileStatus[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 3)
    .map((line) => ({
      code: line.slice(0, 2).trim(),
      path: line.slice(3).trim(),
    }))
    .filter((f) => f.path.length > 0);
}

export interface GitWorkspaceInput {
  repo: string;
  repoPath?: string;
  branch?: string;
  lastCommit?: string;
  /** git status --porcelain 生出力。 */
  status?: string;
}

/**
 * 最新 1 件の git ワークスペース状態を保持するインメモリ store。
 * 元実装はモジュールレベルの単一変数だった。
 */
export class InMemoryGitWorkspaceStore {
  private current: GitWorkspaceState | null = null;

  get(): GitWorkspaceState | null {
    return this.current;
  }

  set(input: GitWorkspaceInput, now: Date = new Date()): GitWorkspaceState {
    this.current = {
      repo: input.repo,
      repoPath: input.repoPath ?? "",
      branch: input.branch ?? "",
      lastCommit: input.lastCommit ?? "",
      files: parsePorcelain(input.status ?? ""),
      updatedAt: now.toISOString(),
    };
    return this.current;
  }
}
