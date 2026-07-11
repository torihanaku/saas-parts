import { describe, it, expect, vi } from "vitest";
import { DeployController } from "./deployControl.js";
import type { GitProvider } from "./gitProvider.js";
import type { WorkflowRun } from "./types.js";

function fakeRun(id: number, event: string): WorkflowRun {
  return {
    id,
    name: "CI",
    status: "completed",
    conclusion: "success",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:05:00Z",
    head_branch: "main",
    run_number: id,
  };
}

function makeProvider(overrides: Partial<GitProvider> = {}): GitProvider {
  return {
    listWorkflowRuns: vi.fn().mockResolvedValue([]),
    listCommits: vi.fn().mockResolvedValue([]),
    listReleases: vi.fn().mockResolvedValue([]),
    listClosedPullRequests: vi.fn().mockResolvedValue([]),
    listOpenIssues: vi.fn().mockResolvedValue([]),
    createIssue: vi.fn(),
    dispatchWorkflow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("DeployController.getStatus", () => {
  it("returns latest staging (push) and production (dispatch) run", async () => {
    const provider = makeProvider({
      listWorkflowRuns: vi.fn(async (p) =>
        p.event === "push" ? [fakeRun(1, "push")] : [fakeRun(2, "workflow_dispatch")],
      ),
    });
    const ctl = new DeployController(provider, { owner: "a", repo: "b" });
    const status = await ctl.getStatus();
    expect(status.staging?.id).toBe(1);
    expect(status.production?.id).toBe(2);
  });
});

describe("DeployController.promote — cooldown", () => {
  it("dispatches then returns the newest run", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider({
      dispatchWorkflow: dispatch,
      listWorkflowRuns: vi.fn().mockResolvedValue([fakeRun(9, "workflow_dispatch")]),
    });
    const ctl = new DeployController(provider, { owner: "a", repo: "b" });
    const res = await ctl.promote(1000);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.run?.id).toBe(9);
    expect(dispatch).toHaveBeenCalledWith("a", "b", "ci.yml", "main");
  });

  it("rate-limits within the cooldown window", async () => {
    const provider = makeProvider();
    const ctl = new DeployController(provider, { owner: "a", repo: "b", promoteCooldownMs: 300000 });
    await ctl.promote(0);
    const res = await ctl.promote(60000); // 1 min later
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("rate_limited");
      expect(res.remainingMinutes).toBe(4);
    }
  });

  it("allows promote again after cooldown elapses", async () => {
    const provider = makeProvider();
    const ctl = new DeployController(provider, { owner: "a", repo: "b", promoteCooldownMs: 300000 });
    await ctl.promote(0);
    const res = await ctl.promote(300000);
    expect(res.ok).toBe(true);
  });
});

describe("DeployController.createIssue — validation", () => {
  it("rejects short titles", async () => {
    const ctl = new DeployController(makeProvider(), { owner: "a", repo: "b" });
    await expect(ctl.createIssue({ title: "hi" })).rejects.toThrow("title_too_short");
  });

  it("rejects overly long titles", async () => {
    const ctl = new DeployController(makeProvider(), { owner: "a", repo: "b" });
    await expect(ctl.createIssue({ title: "x".repeat(201) })).rejects.toThrow("title_too_long");
  });

  it("creates a valid issue through the provider", async () => {
    const createIssue = vi
      .fn()
      .mockResolvedValue({ number: 5, title: "Valid title", html_url: "x" });
    const ctl = new DeployController(makeProvider({ createIssue }), { owner: "a", repo: "b" });
    const issue = await ctl.createIssue({ title: "  Valid title  ", labels: ["bug", 3 as never] });
    expect(issue.number).toBe(5);
    expect(createIssue).toHaveBeenCalledWith("a", "b", {
      title: "Valid title",
      body: undefined,
      labels: ["bug"],
    });
  });
});
