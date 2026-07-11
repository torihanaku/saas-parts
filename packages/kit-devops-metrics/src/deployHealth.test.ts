import { describe, it, expect, vi } from "vitest";
import {
  deployStatus,
  getDeployReach,
  checkStatus,
  worstStatus,
  getSilentFailures,
} from "./deployHealth.js";
import type { GitProvider } from "./gitProvider.js";
import type { SilentFailureCheckConfig } from "./types.js";

const NOW = new Date("2026-02-01T00:00:00Z");

describe("deployStatus thresholds", () => {
  it("healthy > 0.7, degraded > 0.3, else critical", () => {
    expect(deployStatus(0.9)).toBe("healthy");
    expect(deployStatus(0.5)).toBe("degraded");
    expect(deployStatus(0.1)).toBe("critical");
  });
});

describe("getDeployReach", () => {
  it("computes reach_rate = releases / merged_prs (0.5 for 1 release, 2 PRs)", async () => {
    const iso = NOW.toISOString();
    const provider: Pick<GitProvider, "listReleases" | "listClosedPullRequests"> = {
      listReleases: vi.fn().mockResolvedValue([
        { tag_name: "v1.2.3", published_at: iso, html_url: "https://x/releases/v1.2.3" },
      ]),
      listClosedPullRequests: vi.fn().mockResolvedValue([
        { number: 1, state: "closed", merged_at: iso },
        { number: 2, state: "closed", merged_at: iso },
      ]),
    };

    const res = await getDeployReach(provider as GitProvider, {
      owner: "torihanaku",
      repo: "dev-dashboard",
      now: NOW,
    });

    expect(res.repo).toBe("torihanaku/dev-dashboard");
    expect(res.merged_prs).toBe(2);
    expect(res.releases).toBe(1);
    expect(res.reach_rate).toBe(0.5);
    expect(res.latest_release?.tag).toBe("v1.2.3");
  });

  it("ignores unmerged PRs and old releases", async () => {
    const old = new Date(NOW.getTime() - 60 * 86400000).toISOString();
    const provider: Pick<GitProvider, "listReleases" | "listClosedPullRequests"> = {
      listReleases: vi.fn().mockResolvedValue([
        { tag_name: "old", published_at: old, html_url: "x" },
      ]),
      listClosedPullRequests: vi.fn().mockResolvedValue([
        { number: 1, state: "closed", merged_at: null },
      ]),
    };
    const res = await getDeployReach(provider as GitProvider, { owner: "a", repo: "b", now: NOW });
    expect(res.merged_prs).toBe(0);
    expect(res.releases).toBe(0);
    expect(res.reach_rate).toBe(0); // 0 / max(0,1)
    expect(res.status).toBe("critical");
  });
});

describe("silent failures", () => {
  it("checkStatus healthy < threshold, warning < 2x, critical otherwise", () => {
    expect(checkStatus(10, 25)).toBe("healthy");
    expect(checkStatus(30, 25)).toBe("warning");
    expect(checkStatus(60, 25)).toBe("critical");
  });

  it("worstStatus picks the worst", () => {
    expect(worstStatus(["healthy", "warning", "critical"])).toBe("critical");
    expect(worstStatus(["healthy", "warning"])).toBe("warning");
    expect(worstStatus(["healthy"])).toBe("healthy");
  });

  const CHECKS: SilentFailureCheckConfig[] = [
    { name: "reports", threshold_hours: 25, description: "no reports" },
    { name: "backlog", threshold_hours: 72, description: "no tasks" },
  ];

  it("treats null activity as critical, computes hours_since otherwise", async () => {
    const recent = new Date(NOW.getTime() - 5 * 3600000).toISOString(); // 5h ago
    const provider = vi.fn(async (cfg: SilentFailureCheckConfig) =>
      cfg.name === "reports" ? recent : null,
    );

    const res = await getSilentFailures(CHECKS, provider, NOW);

    const reports = res.checks.find((c) => c.name === "reports")!;
    const backlog = res.checks.find((c) => c.name === "backlog")!;
    expect(reports.status).toBe("healthy");
    expect(reports.hours_since).toBe(5);
    expect(backlog.status).toBe("critical");
    expect(backlog.hours_since).toBeNull();
    expect(res.overall_status).toBe("critical");
    expect(res.critical_count).toBe(1);
  });
});
