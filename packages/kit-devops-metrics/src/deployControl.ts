/**
 * デプロイコントロール — ステージング→本番の昇格を管理するコアロジック。
 *
 * 実運用SaaS server/routes/deploy-control.ts から抽出。
 * 認証（super admin）・機能フラグ・HTTP ルーティングは外し、GitProvider 経由の
 * 状態取得 / 昇格トリガー / Issue CRUD と、5 分クールダウンのレート制限だけを提供。
 */
import type { GitProvider, GitIssue } from "./gitProvider.js";
import type { WorkflowRun } from "./types.js";

export interface DeployControlConfig {
  owner: string;
  repo: string;
  /** 昇格に使うワークフローファイル名。既定 "ci.yml"。 */
  workflowFile?: string;
  /** 昇格の ref。既定 "main"。 */
  ref?: string;
  /** 本番デプロイのクールダウン（ms）。既定 5 分。 */
  promoteCooldownMs?: number;
}

export interface DeployControlStatus {
  staging: WorkflowRun | null;
  production: WorkflowRun | null;
}

/**
 * ステートフルなデプロイコントローラ。lastPromoteAt を保持しレート制限する。
 */
export class DeployController {
  private lastPromoteAt: number | null = null;
  private readonly workflowFile: string;
  private readonly ref: string;
  private readonly cooldownMs: number;

  constructor(
    private readonly provider: GitProvider,
    private readonly config: DeployControlConfig,
  ) {
    this.workflowFile = config.workflowFile ?? "ci.yml";
    this.ref = config.ref ?? "main";
    this.cooldownMs = config.promoteCooldownMs ?? 5 * 60 * 1000;
  }

  /** ステージング（push）と本番（workflow_dispatch）の最新実行を返す。 */
  async getStatus(): Promise<DeployControlStatus> {
    const [staging, production] = await Promise.all([
      this.provider.listWorkflowRuns({
        owner: this.config.owner,
        repo: this.config.repo,
        branch: this.ref,
        event: "push",
        perPage: 5,
      }),
      this.provider.listWorkflowRuns({
        owner: this.config.owner,
        repo: this.config.repo,
        branch: this.ref,
        event: "workflow_dispatch",
        perPage: 5,
      }),
    ]);
    return { staging: staging[0] ?? null, production: production[0] ?? null };
  }

  /** クールダウンの残り分数。0 なら昇格可能。 */
  remainingCooldownMinutes(now: number = Date.now()): number {
    if (this.lastPromoteAt === null) return 0;
    const elapsed = now - this.lastPromoteAt;
    if (elapsed >= this.cooldownMs) return 0;
    return Math.ceil((this.cooldownMs - elapsed) / 60000);
  }

  /**
   * 本番昇格をトリガーする。クールダウン中は "rate_limited" を返す。
   */
  async promote(now: number = Date.now()): Promise<
    | { ok: true; run: WorkflowRun | null }
    | { ok: false; error: "rate_limited"; remainingMinutes: number }
  > {
    const remaining = this.remainingCooldownMinutes(now);
    if (remaining > 0) {
      return { ok: false, error: "rate_limited", remainingMinutes: remaining };
    }

    await this.provider.dispatchWorkflow(
      this.config.owner,
      this.config.repo,
      this.workflowFile,
      this.ref,
    );
    this.lastPromoteAt = now;

    const runs = await this.provider.listWorkflowRuns({
      owner: this.config.owner,
      repo: this.config.repo,
      branch: this.ref,
      event: "workflow_dispatch",
      perPage: 1,
    });
    return { ok: true, run: runs[0] ?? null };
  }

  /** オープン Issue 一覧（PR は除外済み）。 */
  async listIssues(): Promise<GitIssue[]> {
    return this.provider.listOpenIssues(this.config.owner, this.config.repo, 10);
  }

  /**
   * Issue を作成する。title は 5〜200 文字。バリデーション NG は Error を throw。
   */
  async createIssue(input: { title: string; body?: string; labels?: string[] }): Promise<{
    number: number;
    title: string;
    html_url: string;
  }> {
    const title = input.title.trim();
    if (title.length < 5) throw new Error("title_too_short");
    if (title.length > 200) throw new Error("title_too_long");
    const labels = Array.isArray(input.labels)
      ? input.labels.filter((l): l is string => typeof l === "string")
      : [];
    return this.provider.createIssue(this.config.owner, this.config.repo, {
      title,
      body: typeof input.body === "string" ? input.body.trim() : undefined,
      labels,
    });
  }
}
