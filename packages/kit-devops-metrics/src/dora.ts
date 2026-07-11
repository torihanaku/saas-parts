/**
 * DORA メトリクス — 4 指標（デプロイ頻度 / リードタイム / 変更失敗率 / MTTR）を
 * GitHub Actions のワークフロー実行から計算する。
 *
 * dev-dashboard-v2 server/routes/dora/{helpers,calculation}.ts から抽出。
 * 計算ロジックは verbatim（ゴールデンテストで固定）。REPOS 定数と GitHub fetch は
 * 引数（repos, GitProvider）に置き換えた。
 */
import type { DoraLevel, DoraMetrics, RepoRef, WorkflowRun } from "./types.js";
import type { GitProvider } from "./gitProvider.js";

type TaggedRun = WorkflowRun & { repoKey: string; repoLabel: string };

/* ── 数値ユーティリティ ─────────────────────────────────────────────────── */

/** ISO 週文字列（例: "2026-W13"）。 */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

export function avg(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function classifyLevel(
  dfWeekly: number,
  ltHours: number,
  cfrPercent: number,
  mttrHours: number,
): DoraLevel {
  // Elite: DF > 7/week, LT < 1hr, CFR < 5%, MTTR < 1hr
  if (dfWeekly > 7 && ltHours < 1 && cfrPercent < 5 && mttrHours < 1) return "Elite";
  // High: DF > 1/week, LT < 24hr, CFR < 15%, MTTR < 24hr
  if (dfWeekly > 1 && ltHours < 24 && cfrPercent < 15 && mttrHours < 24) return "High";
  // Medium: DF > 0.25/week, LT < 168hr, CFR < 30%, MTTR < 168hr
  if (dfWeekly > 0.25 && ltHours < 168 && cfrPercent < 30 && mttrHours < 168) return "Medium";
  return "Low";
}

/* ── コア計算 ───────────────────────────────────────────────────────────── */

/**
 * 事前に取得済みのワークフロー実行から DORA メトリクスを計算する（純関数）。
 * fetch を伴わないのでゴールデンテスト向き。`now` はテスト用に注入可能。
 */
export function computeDoraMetrics(
  repos: RepoRef[],
  allRunsByRepo: Array<{ repo: RepoRef; runs: WorkflowRun[] }>,
  now: Date = new Date(),
): DoraMetrics {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

  // Flatten with repo info
  const allRuns: TaggedRun[] = [];
  for (const { repo, runs } of allRunsByRepo) {
    for (const run of runs) {
      allRuns.push({
        ...run,
        repoKey: `${repo.owner}/${repo.name}`,
        repoLabel: repo.label,
      });
    }
  }

  // Completed runs on main
  const completed = allRuns.filter((r) => r.status === "completed" && r.conclusion !== null);

  // --- Last 30 days subset for headline metrics ---
  const recent = completed.filter((r) => new Date(r.created_at) >= thirtyDaysAgo);
  const recentSuccess = recent.filter((r) => r.conclusion === "success");
  const recentFailed = recent.filter((r) => r.conclusion === "failure");

  // 1. Deployment Frequency (deploys per week, last 30 days ~ 4.29 weeks)
  const weeks30d = 30 / 7;
  const dfValue = round2(recentSuccess.length / weeks30d);

  // 2. Lead Time (updated_at - created_at for successful runs, in hours)
  const leadTimes = recentSuccess
    .map((r) => (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 3600000)
    .filter((h) => h > 0);
  const ltValue = round2(avg(leadTimes));

  // 3. Change Failure Rate
  const cfrValue = recent.length > 0 ? round2((recentFailed.length / recent.length) * 100) : 0;

  // 4. MTTR: for each failure, find next success on same repo, average the gap
  const recoveryTimes: number[] = [];
  for (const repo of repos) {
    const repoRuns = completed
      .filter((r) => r.repoLabel === repo.label)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    for (let i = 0; i < repoRuns.length; i++) {
      if (repoRuns[i]!.conclusion === "failure") {
        for (let j = i + 1; j < repoRuns.length; j++) {
          if (repoRuns[j]!.conclusion === "success") {
            const failTime = new Date(repoRuns[i]!.created_at).getTime();
            const recoverTime = new Date(repoRuns[j]!.updated_at).getTime();
            const hours = (recoverTime - failTime) / 3600000;
            if (hours > 0) recoveryTimes.push(hours);
            break;
          }
        }
      }
    }
  }
  const mttrValue = round2(avg(recoveryTimes));

  // --- Per-repo breakdown ---
  const byRepo = repos.map((repo) => {
    const repoRecent = recent.filter((r) => r.repoLabel === repo.label);
    const repoSuccess = repoRecent.filter((r) => r.conclusion === "success");
    const repoFailed = repoRecent.filter((r) => r.conclusion === "failure");

    const repoLeadTimes = repoSuccess
      .map((r) => (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 3600000)
      .filter((h) => h > 0);

    return {
      repo: `${repo.owner}/${repo.name}`,
      label: repo.label,
      deploymentFrequency: round2(repoSuccess.length / weeks30d),
      leadTime: round2(avg(repoLeadTimes)),
      changeFailureRate: repoRecent.length > 0 ? round2((repoFailed.length / repoRecent.length) * 100) : 0,
    };
  });

  // --- Weekly Trend (last 12 weeks) ---
  const weeklyTrend: DoraMetrics["weeklyTrend"] = [];
  for (let w = 11; w >= 0; w--) {
    const wStart = new Date(now.getTime() - (w + 1) * 7 * 86400000);
    const wEnd = new Date(now.getTime() - w * 7 * 86400000);
    const weekLabel = isoWeek(wStart);

    const weekRuns = completed.filter((r) => {
      const d = new Date(r.created_at);
      return d >= wStart && d < wEnd;
    });
    const weekSuccess = weekRuns.filter((r) => r.conclusion === "success");
    const weekFailed = weekRuns.filter((r) => r.conclusion === "failure");

    const weekLeadTimes = weekSuccess
      .map((r) => (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 3600000)
      .filter((h) => h > 0);

    weeklyTrend.push({
      week: weekLabel,
      deployments: weekSuccess.length,
      failures: weekFailed.length,
      avgLeadTime: round2(avg(weekLeadTimes)),
    });
  }

  // --- Level ---
  const level = classifyLevel(dfValue, ltValue, cfrValue, mttrValue);

  const ltTrendArray = weeklyTrend.map((w) => w.avgLeadTime);

  const cfrTrendArray = weeklyTrend.map((w) => {
    const total = w.deployments + w.failures;
    return total > 0 ? round2((w.failures / total) * 100) : 0;
  });

  return {
    deploymentFrequency: {
      daily: round2(dfValue / 7),
      weekly: dfValue,
      monthly: recentSuccess.length,
      trend: weeklyTrend.map((w) => w.deployments),
    },
    leadTimeForChanges: {
      avgHours: ltValue,
      medianHours: ltValue,
      p90Hours: ltValue,
      trend: ltTrendArray,
    },
    changeFailureRate: {
      rate: cfrValue,
      totalDeploys: recent.length,
      failures: recentFailed.length,
      trend: cfrTrendArray,
    },
    mttr: {
      avgHours: mttrValue,
      medianHours: mttrValue,
      incidents: recentFailed.length,
    },
    period: `${thirtyDaysAgo.toISOString().split("T")[0]} ~ ${now.toISOString().split("T")[0]}`,
    repoBreakdown: byRepo.map((r) => ({
      repo: r.label,
      deployFreq: r.deploymentFrequency,
      failRate: r.changeFailureRate,
      avgLeadTime: r.leadTime,
    })),
    weeklyTrend,
    level,
    updatedAt: now.toISOString(),
  };
}

/**
 * GitProvider から 90 日分のワークフロー実行を取得し DORA メトリクスを計算する。
 */
export async function calculateDoraMetrics(
  repos: RepoRef[],
  provider: GitProvider,
  now: Date = new Date(),
): Promise<DoraMetrics> {
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000);
  const sinceDate = ninetyDaysAgo.toISOString().split("T")[0]!;

  const allRunsByRepo = await Promise.all(
    repos.map(async (repo) => {
      const runs = await provider.listWorkflowRuns({
        owner: repo.owner,
        repo: repo.name,
        since: sinceDate,
        branch: "main",
        perPage: 100,
      });
      return { repo, runs };
    }),
  );

  return computeDoraMetrics(repos, allRunsByRepo, now);
}
