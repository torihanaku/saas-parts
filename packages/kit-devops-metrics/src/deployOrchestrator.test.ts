import { describe, it, expect, vi } from "vitest";
import {
  runAutonomousDeploy,
  type OrchestratorDeps,
  type SubmissionStore,
} from "./deployOrchestrator.js";
import type { DeployAdapter, DeployStep, SubmissionRecord } from "./types.js";

const SUBMISSION_ID = "33333333-3333-3333-3333-333333333333";
const TENANT_ID = "44444444-4444-4444-4444-444444444444";

const APPROVED: SubmissionRecord = {
  id: SUBMISSION_ID,
  tenantId: TENANT_ID,
  title: "Promo Headline",
  contentText: "Body of approved submission. ".repeat(20),
  status: "approved",
  autoDeploy: true,
  deployLog: [],
};

function makeStore(submission: SubmissionRecord | null): {
  store: SubmissionStore;
  persisted: DeployStep[][];
} {
  const persisted: DeployStep[][] = [];
  const store: SubmissionStore = {
    getById: vi.fn().mockResolvedValue(submission),
    updateDeployLog: vi.fn(async (_id: string, log: DeployStep[]) => {
      persisted.push(log);
    }),
  };
  return { store, persisted };
}

function okAdapter(target: string): DeployAdapter {
  return {
    target,
    run: vi.fn().mockResolvedValue({ status: "success", detail: { externalId: `${target}-1` } }),
    rollback: vi.fn().mockResolvedValue(undefined),
  };
}

function throwingAdapter(target: string, message: string): DeployAdapter {
  return {
    target,
    run: vi.fn().mockRejectedValue(new Error(message)),
    rollback: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runAutonomousDeploy — gating", () => {
  it("skips when feature flag off (and not forced)", async () => {
    const { store } = makeStore(APPROVED);
    const deps: OrchestratorDeps = { store, registry: {}, isFeatureEnabled: () => false };
    const res = await runAutonomousDeploy(SUBMISSION_ID, deps);
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("feature_flag_disabled");
  });

  it("throws when submission missing", async () => {
    const { store } = makeStore(null);
    const deps: OrchestratorDeps = { store, registry: {} };
    await expect(runAutonomousDeploy(SUBMISSION_ID, deps)).rejects.toThrow("submission_not_found");
  });

  it("skips when status != approved", async () => {
    const { store } = makeStore({ ...APPROVED, status: "draft" });
    const deps: OrchestratorDeps = { store, registry: {} };
    const res = await runAutonomousDeploy(SUBMISSION_ID, deps);
    expect(res.status).toBe("skipped");
    expect(res.reason).toContain("submission_status_not_approved");
  });

  it("skips when auto_deploy=false and not forced", async () => {
    const { store } = makeStore({ ...APPROVED, autoDeploy: false });
    const deps: OrchestratorDeps = { store, registry: {} };
    const res = await runAutonomousDeploy(SUBMISSION_ID, deps);
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("auto_deploy_not_opted_in");
  });

  it("force=true bypasses auto_deploy guard", async () => {
    const { store } = makeStore({ ...APPROVED, autoDeploy: false });
    const registry = { seo: okAdapter("seo") };
    const deps: OrchestratorDeps = { store, registry };
    const res = await runAutonomousDeploy(SUBMISSION_ID, deps, { force: true });
    expect(res.status).toBe("success");
  });
});

describe("runAutonomousDeploy — happy path", () => {
  it("runs all targets in order, persists merged deploy_log", async () => {
    const { store, persisted } = makeStore({ ...APPROVED, deployLog: [] });
    const registry = { seo: okAdapter("seo"), cms: okAdapter("cms") };
    const audit = vi.fn();
    const notify = vi.fn();
    const deps: OrchestratorDeps = { store, registry, defaultTargets: ["seo", "cms"], audit, notify };

    const res = await runAutonomousDeploy(SUBMISSION_ID, deps, { triggeredBy: "test" });

    expect(res.status).toBe("success");
    expect(res.steps.map((s) => s.target)).toEqual(["seo", "cms"]);
    expect(res.steps.every((s) => s.status === "success")).toBe(true);
    expect(persisted[0]).toHaveLength(2);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }));
  });

  it("skips targets that have no adapter", async () => {
    const { store } = makeStore(APPROVED);
    const registry = { seo: okAdapter("seo") };
    const deps: OrchestratorDeps = { store, registry, defaultTargets: ["seo", "missing"] };
    const res = await runAutonomousDeploy(SUBMISSION_ID, deps);
    const missing = res.steps.find((s) => s.target === "missing")!;
    expect(missing.status).toBe("skipped");
    expect(missing.error).toContain("no_adapter_for_target");
  });
});

describe("runAutonomousDeploy — failure + rollback", () => {
  it("rolls back earlier successes when a later target fails", async () => {
    const { store } = makeStore(APPROVED);
    const seo = okAdapter("seo");
    const cms = throwingAdapter("cms", "cms_blew_up");
    const deps: OrchestratorDeps = {
      store,
      registry: { seo, cms },
      defaultTargets: ["seo", "cms"],
    };

    const res = await runAutonomousDeploy(SUBMISSION_ID, deps);

    expect(res.status).toBe("failed");
    expect(res.reason).toBe("cms_blew_up");
    // seo rolled back
    expect(seo.rollback).toHaveBeenCalledTimes(1);
    const seoStep = res.steps.find((s) => s.target === "seo")!;
    expect(seoStep.status).toBe("rolled_back");
    // cms failed, log step never ran (break)
    const cmsStep = res.steps.find((s) => s.target === "cms")!;
    expect(cmsStep.status).toBe("failed");
  });
});
