/**
 * Tests for runAutonomousDeploy (ported from dev-dashboard-v2 orchestrator.test.ts).
 * Supabase / audit / feature-flags を InMemoryDeployStore + 注入 audit / enabled に置換。
 * ハードコードされていたアダプタは注入レジストリのスタブに置換。
 */
import { describe, it, expect, vi } from "vitest";

import { runAutonomousDeploy } from "./orchestrator";
import { InMemoryDeployStore } from "./store";
import type {
  AutonomousDeployConfig,
  AuditFn,
} from "./orchestrator";
import type { DeployAdapter, DeployAdapterResult, SubmissionRecord } from "./types";

const APPROVED_SUBMISSION: SubmissionRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  tenant_id: "22222222-2222-2222-2222-222222222222",
  title: "Approved promo title",
  content_text: "promo body",
  status: "approved",
  auto_deploy: true,
  deploy_log: [],
};

function stubAdapter(
  target: DeployAdapter["target"],
  run: () => Promise<DeployAdapterResult>,
  rollback: () => Promise<void> = async () => {},
): DeployAdapter {
  return { target, run: vi.fn(run), rollback: vi.fn(rollback) };
}

function makeConfig(overrides: Partial<AutonomousDeployConfig> = {}): AutonomousDeployConfig {
  return {
    store: overrides.store ?? new InMemoryDeployStore([APPROVED_SUBMISSION]),
    adapters: overrides.adapters ?? {},
    enabled: overrides.enabled ?? (() => true),
    audit: overrides.audit,
    notify: overrides.notify,
    logger: overrides.logger,
  };
}

describe("runAutonomousDeploy — feature flag", () => {
  it("skips when disabled and force=false", async () => {
    const config = makeConfig({ enabled: () => false });
    const result = await runAutonomousDeploy(config, APPROVED_SUBMISSION.id);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("feature_flag_disabled");
    expect(result.steps).toHaveLength(0);
  });
});

describe("runAutonomousDeploy — submission preconditions", () => {
  it("throws if submission is missing", async () => {
    const config = makeConfig({ store: new InMemoryDeployStore([]) });
    await expect(runAutonomousDeploy(config, "missing-id")).rejects.toThrow("submission_not_found");
  });

  it("skips when submission status is not approved", async () => {
    const store = new InMemoryDeployStore([{ ...APPROVED_SUBMISSION, status: "draft" }]);
    const result = await runAutonomousDeploy(makeConfig({ store }), APPROVED_SUBMISSION.id);
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("submission_status_not_approved");
  });

  it("skips when auto_deploy=false and force=false", async () => {
    const store = new InMemoryDeployStore([{ ...APPROVED_SUBMISSION, auto_deploy: false }]);
    const result = await runAutonomousDeploy(makeConfig({ store }), APPROVED_SUBMISSION.id);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("auto_deploy_not_opted_in");
  });
});

describe("runAutonomousDeploy — SEO adapter success path", () => {
  it("persists a successful step and audits as approved (low risk)", async () => {
    const store = new InMemoryDeployStore([APPROVED_SUBMISSION]);
    const seo = stubAdapter("seo", async () => ({
      status: "success",
      detail: { adapter: "seo", indexed: [{ platform: "google-search-console", url: "https://example.com/post" }] },
    }));
    const audit: AuditFn = vi.fn();
    const config = makeConfig({ store, adapters: { seo }, audit });

    const result = await runAutonomousDeploy(config, APPROVED_SUBMISSION.id, {
      targets: ["seo"],
      triggeredBy: "test-runner",
    });

    expect(result.status).toBe("success");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ target: "seo", status: "success" });

    // deploy_log persisted
    const persisted = store._get(APPROVED_SUBMISSION.id);
    expect(persisted?.deploy_log).toEqual(
      expect.arrayContaining([expect.objectContaining({ target: "seo", status: "success" })]),
    );

    // Audit: not a failure
    expect(audit).toHaveBeenCalledWith(
      APPROVED_SUBMISSION.tenant_id,
      expect.objectContaining({
        action: "agent_action_approved",
        resourceType: "dd_submission",
        resourceId: APPROVED_SUBMISSION.id,
        riskLevel: "low",
      }),
    );
  });
});

describe("runAutonomousDeploy — rollback after later failure", () => {
  it("rolls back the SEO step when a subsequent adapter throws", async () => {
    const store = new InMemoryDeployStore([APPROVED_SUBMISSION]);
    const seoRollback = vi.fn(async () => {});
    const seo: DeployAdapter = {
      target: "seo",
      run: vi.fn(async (): Promise<DeployAdapterResult> => ({ status: "success", detail: { externalId: "seo-row-99" } })),
      rollback: seoRollback,
    };
    const cms = stubAdapter("cms", async () => {
      throw new Error("cms_blew_up");
    });
    const config = makeConfig({ store, adapters: { seo, cms } });

    const result = await runAutonomousDeploy(config, APPROVED_SUBMISSION.id, { targets: ["seo", "cms"] });

    expect(result.status).toBe("failed");
    const seoStep = result.steps.find((s) => s.target === "seo");
    const cmsStep = result.steps.find((s) => s.target === "cms");
    expect(cmsStep?.status).toBe("failed");
    expect(cmsStep?.error).toContain("cms_blew_up");
    expect(seoStep?.status).toBe("rolled_back");

    expect(seo.run).toHaveBeenCalled();
    expect(seoRollback).toHaveBeenCalledWith(
      expect.objectContaining({ id: APPROVED_SUBMISSION.id }),
      expect.objectContaining({ target: "seo" }),
    );
    expect(cms.run).toHaveBeenCalled();
  });

  it("audits as rejected (high risk) on failure", async () => {
    const store = new InMemoryDeployStore([APPROVED_SUBMISSION]);
    const cms = stubAdapter("cms", async () => {
      throw new Error("boom");
    });
    const audit: AuditFn = vi.fn();
    const config = makeConfig({ store, adapters: { cms }, audit });

    const result = await runAutonomousDeploy(config, APPROVED_SUBMISSION.id, { targets: ["cms"] });
    expect(result.status).toBe("failed");
    expect(audit).toHaveBeenCalledWith(
      APPROVED_SUBMISSION.tenant_id,
      expect.objectContaining({ action: "agent_action_rejected", riskLevel: "high" }),
    );
  });
});

describe("runAutonomousDeploy — unregistered channels", () => {
  it("records skipped(adapter_not_registered) for channels with no adapter", async () => {
    const store = new InMemoryDeployStore([APPROVED_SUBMISSION]);
    const config = makeConfig({ store, adapters: {} });
    const result = await runAutonomousDeploy(config, APPROVED_SUBMISSION.id, { targets: ["sns", "ad"] });
    // No success => partial
    expect(result.status).toBe("partial");
    expect(result.steps.map((s) => s.status)).toEqual(["skipped", "skipped"]);
    expect(result.steps[0]!.error).toBe("adapter_not_registered");
  });
});

describe("runAutonomousDeploy — notify", () => {
  it("invokes notify with the run result and swallows notify errors", async () => {
    const store = new InMemoryDeployStore([APPROVED_SUBMISSION]);
    const seo = stubAdapter("seo", async () => ({ status: "success" }));
    const notify = vi.fn().mockRejectedValue(new Error("slack down"));
    const logger = vi.fn();
    const config = makeConfig({ store, adapters: { seo }, notify, logger });

    const result = await runAutonomousDeploy(config, APPROVED_SUBMISSION.id, { targets: ["seo"] });
    expect(result.status).toBe("success");
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: APPROVED_SUBMISSION.id, status: "success" }),
    );
    expect(logger).toHaveBeenCalledWith("warn", "autonomous_deploy_notify_failed", expect.any(Error));
  });
});
