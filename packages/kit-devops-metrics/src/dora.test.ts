import { describe, it, expect, vi } from "vitest";
import {
  isoWeek,
  avg,
  round2,
  classifyLevel,
  computeDoraMetrics,
  calculateDoraMetrics,
} from "./dora.js";
import type { GitProvider } from "./gitProvider.js";
import type { RepoRef, WorkflowRun } from "./types.js";

/* ── math utilities ─────────────────────────────────────────────────────── */

describe("math utilities", () => {
  it("avg averages, empty -> 0", () => {
    expect(avg([2, 4, 6])).toBe(4);
    expect(avg([])).toBe(0);
  });

  it("round2 rounds to 2 decimals", () => {
    expect(round2(1.23456)).toBe(1.23);
    expect(round2(1.005)).toBe(1.0);
  });

  it("isoWeek returns YYYY-Www", () => {
    expect(isoWeek(new Date("2026-01-05T00:00:00Z"))).toMatch(/^2026-W\d{2}$/);
  });
});

describe("classifyLevel", () => {
  it("Elite when all thresholds met", () => {
    expect(classifyLevel(10, 0.5, 2, 0.5)).toBe("Elite");
  });
  it("High tier", () => {
    expect(classifyLevel(2, 10, 10, 10)).toBe("High");
  });
  it("Medium tier", () => {
    expect(classifyLevel(0.5, 100, 20, 100)).toBe("Medium");
  });
  it("Low tier when nothing qualifies", () => {
    expect(classifyLevel(0.1, 300, 50, 300)).toBe("Low");
  });
});

/* ── golden fixture ─────────────────────────────────────────────────────── */

// Fixed reference time so every relative date is deterministic.
const NOW = new Date("2026-02-01T00:00:00Z");
const REPO: RepoRef = { owner: "acme", name: "web", label: "Web" };

// Helper to build a completed run N days before NOW with a given lead time (hours).
function run(
  id: number,
  daysAgo: number,
  conclusion: "success" | "failure",
  leadHours: number,
): WorkflowRun {
  const created = new Date(NOW.getTime() - daysAgo * 86400000);
  const updated = new Date(created.getTime() + leadHours * 3600000);
  return {
    id,
    name: "CI",
    status: "completed",
    conclusion,
    created_at: created.toISOString(),
    updated_at: updated.toISOString(),
    head_branch: "main",
    run_number: id,
  };
}

describe("computeDoraMetrics — golden", () => {
  // Within last 30 days: 3 successes (lead 1h,2h,3h) + 1 failure that recovers
  // via a later success. Ordered oldest->newest for MTTR reasoning.
  const runs: WorkflowRun[] = [
    run(1, 20, "failure", 0), // failure at day-20
    run(2, 19, "success", 5), // recovery: created day-19, updated +5h
    run(3, 10, "success", 1),
    run(4, 5, "success", 2),
    run(5, 2, "success", 3),
  ];

  const metrics = computeDoraMetrics([REPO], [{ repo: REPO, runs }], NOW);

  it("deployment frequency: 4 successes over 30/7 weeks", () => {
    // 4 successes / (30/7) = 0.933... -> 0.93
    expect(metrics.deploymentFrequency.weekly).toBe(0.93);
    expect(metrics.deploymentFrequency.monthly).toBe(4);
    expect(metrics.deploymentFrequency.daily).toBe(round2(0.93 / 7));
  });

  it("lead time: avg of successful runs' lead hours (5,1,2,3)", () => {
    // avg(5,1,2,3) = 2.75
    expect(metrics.leadTimeForChanges.avgHours).toBe(2.75);
  });

  it("change failure rate: 1 failure / 5 recent = 20%", () => {
    expect(metrics.changeFailureRate.rate).toBe(20);
    expect(metrics.changeFailureRate.totalDeploys).toBe(5);
    expect(metrics.changeFailureRate.failures).toBe(1);
  });

  it("MTTR: gap from failure(day-20 created) to next success(day-19 updated +5h)", () => {
    // failTime = NOW-20d, recoverTime = (NOW-19d)+5h => 24h + 5h = 29h
    expect(metrics.mttr.avgHours).toBe(29);
    expect(metrics.mttr.incidents).toBe(1);
  });

  it("level and shape are well-formed", () => {
    expect(["Elite", "High", "Medium", "Low"]).toContain(metrics.level);
    expect(metrics.weeklyTrend).toHaveLength(12);
    expect(metrics.repoBreakdown[0]!.repo).toBe("Web");
    expect(metrics.updatedAt).toBe(NOW.toISOString());
  });

  it("ignores non-completed runs", () => {
    const withPending: WorkflowRun = {
      ...run(9, 3, "success", 1),
      status: "in_progress",
      conclusion: null,
    };
    const m = computeDoraMetrics([REPO], [{ repo: REPO, runs: [...runs, withPending] }], NOW);
    expect(m.deploymentFrequency.monthly).toBe(4); // pending not counted
  });
});

/* ── calculateDoraMetrics via provider ──────────────────────────────────── */

describe("calculateDoraMetrics", () => {
  it("fetches runs per repo through the provider and computes", async () => {
    const runs: WorkflowRun[] = [run(1, 3, "success", 2)];
    const provider: Pick<GitProvider, "listWorkflowRuns"> = {
      listWorkflowRuns: vi.fn().mockResolvedValue(runs),
    };
    const m = await calculateDoraMetrics([REPO], provider as GitProvider, NOW);
    expect(provider.listWorkflowRuns).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "web", branch: "main" }),
    );
    expect(m.deploymentFrequency.monthly).toBe(1);
  });
});
