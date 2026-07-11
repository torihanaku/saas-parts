/**
 * デプロイ健全性 — デプロイ到達率とサイレント障害検知。
 *
 * dev-dashboard-v2 server/routes/deploy-health.ts から抽出。
 *  - デプロイ到達率: マージ済み PR のうち本番リリース（タグ）まで到達した割合。
 *    トークン未設定時はフェイルクローズ（呼び出し側で判定）。
 *  - サイレント障害: 主要な出力の最終タイムスタンプを閾値と比較して停止を検知。
 *    元は Supabase の最終行取得だったが、`lastActivityAt` プロバイダを注入する
 *    形に置き換えた。
 */
import type {
  CheckStatus,
  DeployReachResult,
  DeployStatus,
  OverallStatus,
  SilentFailureCheck,
  SilentFailureCheckConfig,
  SilentFailuresResult,
} from "./types.js";
import type { GitProvider } from "./gitProvider.js";

/* ── デプロイ到達率 ─────────────────────────────────────────────────────── */

export function deployStatus(reachRate: number): DeployStatus {
  if (reachRate > 0.7) return "healthy";
  if (reachRate > 0.3) return "degraded";
  return "critical";
}

export interface DeployReachOptions {
  owner: string;
  repo: string;
  /** 集計期間（日）。既定 30。 */
  periodDays?: number;
  now?: Date;
}

/**
 * 直近 periodDays のマージ済み PR とリリースからデプロイ到達率を計算する。
 */
export async function getDeployReach(
  provider: GitProvider,
  options: DeployReachOptions,
): Promise<DeployReachResult> {
  const periodDays = options.periodDays ?? 30;
  const now = (options.now ?? new Date()).getTime();
  const repoLabel = `${options.owner}/${options.repo}`;

  const [releases, prs] = await Promise.all([
    provider.listReleases(options.owner, options.repo, 10),
    provider.listClosedPullRequests(options.owner, options.repo, 20),
  ]);

  const since = new Date(now - periodDays * 24 * 60 * 60 * 1000);

  const recentReleases = releases.filter((r) => new Date(r.published_at) >= since);
  const mergedPRs = prs.filter((pr) => pr.merged_at !== null && new Date(pr.merged_at) >= since);

  const merged_prs = mergedPRs.length;
  const releaseCount = recentReleases.length;

  // NOTE: reach_rate は 1.0 で頭打ち。リリース数がマージ PR 数を上回るケース
  // （hotfix タグ・非 PR リリース）はフルカバレッジとして扱う。
  const reach_rate = Math.min(releaseCount / Math.max(merged_prs, 1), 1.0);

  const latestRelease = recentReleases[0] ?? null;

  return {
    repo: repoLabel,
    period_days: periodDays,
    merged_prs,
    releases: releaseCount,
    reach_rate,
    latest_release: latestRelease
      ? { tag: latestRelease.tag_name, published_at: latestRelease.published_at }
      : null,
    status: deployStatus(reach_rate),
  };
}

/* ── サイレント障害検知 ─────────────────────────────────────────────────── */

export function checkStatus(hours_since: number, threshold_hours: number): CheckStatus {
  if (hours_since < threshold_hours) return "healthy";
  if (hours_since < threshold_hours * 2) return "warning";
  return "critical";
}

export function worstStatus(statuses: CheckStatus[]): OverallStatus {
  if (statuses.includes("critical")) return "critical";
  if (statuses.includes("warning")) return "warning";
  return "healthy";
}

/**
 * 各チェック対象の最終アクティビティ時刻を返す注入プロバイダ。
 * 元実装は Supabase の最終行 timestamp を取得していた。null は「行なし＝critical」。
 */
export type LastActivityProvider = (check: SilentFailureCheckConfig) => Promise<string | null>;

/**
 * 設定リストを走査し、各対象が閾値時間内に更新されているかを検査する。
 */
export async function getSilentFailures(
  checks: SilentFailureCheckConfig[],
  lastActivityOf: LastActivityProvider,
  now: Date = new Date(),
): Promise<SilentFailuresResult> {
  const results = await Promise.all(
    checks.map(async (cfg): Promise<SilentFailureCheck> => {
      const last_activity = await lastActivityOf(cfg);

      if (!last_activity) {
        return {
          name: cfg.name,
          status: "critical",
          last_activity: null,
          hours_since: null,
          threshold_hours: cfg.threshold_hours,
          description: cfg.description,
        };
      }

      const hours_since = (now.getTime() - new Date(last_activity).getTime()) / (1000 * 60 * 60);

      return {
        name: cfg.name,
        status: checkStatus(hours_since, cfg.threshold_hours),
        last_activity,
        hours_since: Math.round(hours_since * 10) / 10,
        threshold_hours: cfg.threshold_hours,
        description: cfg.description,
      };
    }),
  );

  const statuses = results.map((r) => r.status);

  return {
    checks: results,
    overall_status: worstStatus(statuses),
    critical_count: statuses.filter((s) => s === "critical").length,
    warning_count: statuses.filter((s) => s === "warning").length,
  };
}
