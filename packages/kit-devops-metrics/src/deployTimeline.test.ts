import { describe, it, expect } from "vitest";
import {
  isDeployTarget,
  isDeployStepStatus,
  normalizeDeployTimeline,
  summarizeDeployTimeline,
  type DeployTimelineSubmissionRow,
} from "./deployTimeline.js";

const VALID = new Set(["seo", "cms", "sns", "ad"]);

const BASE_ROW: DeployTimelineSubmissionRow = {
  id: "sub-1",
  title: "Test submission",
  status: "approved",
  submitted_at: "2026-01-01T00:00:00Z",
  decided_at: "2026-01-01T01:00:00Z",
  auto_deploy: true,
  deploy_log: null,
};

function makeStep(overrides: Record<string, unknown> = {}) {
  return {
    target: "seo",
    status: "success",
    startedAt: "2026-01-01T02:00:00Z",
    finishedAt: "2026-01-01T02:01:00Z",
    ...overrides,
  };
}

describe("isDeployTarget", () => {
  it.each(["seo", "cms", "sns", "ad"])('accepts "%s" against valid set', (v) => {
    expect(isDeployTarget(v, VALID)).toBe(true);
  });

  it.each([null, undefined, 123, "", "email", "facebook"])("rejects %s against valid set", (v) => {
    expect(isDeployTarget(v, VALID)).toBe(false);
  });

  it("accepts any non-empty string when no valid set is given (generalized)", () => {
    expect(isDeployTarget("anything")).toBe(true);
    expect(isDeployTarget("")).toBe(false);
    expect(isDeployTarget(123)).toBe(false);
  });
});

describe("isDeployStepStatus", () => {
  it.each(["pending", "running", "success", "failed", "skipped", "rolled_back"])(
    'accepts "%s"',
    (v) => {
      expect(isDeployStepStatus(v)).toBe(true);
    },
  );

  it.each([null, undefined, 0, "", "done", "error"])("rejects %s", (v) => {
    expect(isDeployStepStatus(v)).toBe(false);
  });
});

describe("normalizeDeployTimeline", () => {
  it("returns empty array when no rows", () => {
    expect(normalizeDeployTimeline([])).toEqual([]);
  });

  it("returns empty array when deploy_log is null", () => {
    expect(normalizeDeployTimeline([BASE_ROW])).toEqual([]);
  });

  it("returns empty array when deploy_log is empty array", () => {
    const row = { ...BASE_ROW, deploy_log: [] };
    expect(normalizeDeployTimeline([row])).toEqual([]);
  });

  it("normalizes a valid step correctly", () => {
    const step = makeStep();
    const row = { ...BASE_ROW, deploy_log: [step] };
    const result = normalizeDeployTimeline([row], {}, VALID);

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.submissionId).toBe("sub-1");
    expect(item.submissionTitle).toBe("Test submission");
    expect(item.submissionStatus).toBe("approved");
    expect(item.autoDeploy).toBe(true);
    expect(item.target).toBe("seo");
    expect(item.status).toBe("success");
    expect(item.startedAt).toBe("2026-01-01T02:00:00Z");
    expect(item.finishedAt).toBe("2026-01-01T02:01:00Z");
    expect(item.durationMs).toBe(60_000);
    expect(item.error).toBeNull();
    expect(item.detail).toBeNull();
  });

  it("generates stable id from row id + index + target + startedAt", () => {
    const step = makeStep({ target: "cms" });
    const row = { ...BASE_ROW, deploy_log: [step] };
    const [item] = normalizeDeployTimeline([row], {}, VALID);
    expect(item!.id).toBe("sub-1:0:cms:2026-01-01T02:00:00Z");
  });

  it("skips steps with invalid target when a valid set is enforced", () => {
    const row = { ...BASE_ROW, deploy_log: [makeStep({ target: "unknown" })] };
    expect(normalizeDeployTimeline([row], {}, VALID)).toHaveLength(0);
  });

  it("skips steps with invalid status", () => {
    const row = { ...BASE_ROW, deploy_log: [makeStep({ status: "done" })] };
    expect(normalizeDeployTimeline([row], {}, VALID)).toHaveLength(0);
  });

  it("skips steps with invalid startedAt", () => {
    const row = { ...BASE_ROW, deploy_log: [makeStep({ startedAt: "not-a-date" })] };
    expect(normalizeDeployTimeline([row], {}, VALID)).toHaveLength(0);
  });

  it("treats missing finishedAt as null (no duration)", () => {
    const step = makeStep({ finishedAt: undefined });
    const row = { ...BASE_ROW, deploy_log: [step] };
    const [item] = normalizeDeployTimeline([row], {}, VALID);
    expect(item!.finishedAt).toBeNull();
    expect(item!.durationMs).toBeNull();
  });

  it("extracts error string from step", () => {
    const step = makeStep({ status: "failed", error: "timeout" });
    const row = { ...BASE_ROW, deploy_log: [step] };
    const [item] = normalizeDeployTimeline([row], {}, VALID);
    expect(item!.error).toBe("timeout");
  });

  it("ignores non-string error", () => {
    const step = makeStep({ error: 42 });
    const row = { ...BASE_ROW, deploy_log: [step] };
    const [item] = normalizeDeployTimeline([row], {}, VALID);
    expect(item!.error).toBeNull();
  });

  it("extracts detail object from step", () => {
    const detail = { externalId: "post-123" };
    const step = makeStep({ detail });
    const row = { ...BASE_ROW, deploy_log: [step] };
    const [item] = normalizeDeployTimeline([row], {}, VALID);
    expect(item!.detail).toEqual(detail);
  });

  it("ignores detail that is an array", () => {
    const step = makeStep({ detail: ["a", "b"] });
    const row = { ...BASE_ROW, deploy_log: [step] };
    const [item] = normalizeDeployTimeline([row], {}, VALID);
    expect(item!.detail).toBeNull();
  });

  it("falls back to 'Untitled submission' when title is null", () => {
    const row = { ...BASE_ROW, title: null, deploy_log: [makeStep()] };
    const [item] = normalizeDeployTimeline([row], {}, VALID);
    expect(item!.submissionTitle).toBe("Untitled submission");
  });

  it("falls back to 'unknown' when status is null", () => {
    const row = { ...BASE_ROW, status: null, deploy_log: [makeStep()] };
    const [item] = normalizeDeployTimeline([row], {}, VALID);
    expect(item!.submissionStatus).toBe("unknown");
  });

  it("sets autoDeploy false when auto_deploy is null", () => {
    const row = { ...BASE_ROW, auto_deploy: null, deploy_log: [makeStep()] };
    const [item] = normalizeDeployTimeline([row], {}, VALID);
    expect(item!.autoDeploy).toBe(false);
  });

  it("sorts by startedAt descending", () => {
    const step1 = makeStep({ startedAt: "2026-01-01T01:00:00Z", finishedAt: undefined });
    const step2 = makeStep({ startedAt: "2026-01-01T03:00:00Z", finishedAt: undefined });
    const row = { ...BASE_ROW, deploy_log: [step1, step2] };
    const result = normalizeDeployTimeline([row], {}, VALID);
    expect(result[0]!.startedAt).toBe("2026-01-01T03:00:00Z");
    expect(result[1]!.startedAt).toBe("2026-01-01T01:00:00Z");
  });

  it("filters by target", () => {
    const row = {
      ...BASE_ROW,
      deploy_log: [
        makeStep({ target: "seo", startedAt: "2026-01-01T02:00:00Z" }),
        makeStep({ target: "cms", startedAt: "2026-01-01T02:01:00Z" }),
      ],
    };
    const result = normalizeDeployTimeline([row], { target: "cms" }, VALID);
    expect(result).toHaveLength(1);
    expect(result[0]!.target).toBe("cms");
  });

  it("filters by status", () => {
    const row = {
      ...BASE_ROW,
      deploy_log: [
        makeStep({ status: "success", startedAt: "2026-01-01T02:00:00Z" }),
        makeStep({ status: "failed", startedAt: "2026-01-01T02:01:00Z" }),
      ],
    };
    const result = normalizeDeployTimeline([row], { status: "failed" }, VALID);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("failed");
  });

  it("filters steps before 'from' date", () => {
    const old = makeStep({ startedAt: "2026-01-01T00:00:00Z", finishedAt: undefined });
    const recent = makeStep({ startedAt: "2026-01-10T00:00:00Z", finishedAt: undefined });
    const row = { ...BASE_ROW, deploy_log: [old, recent] };
    const result = normalizeDeployTimeline([row], { from: new Date("2026-01-05T00:00:00Z") }, VALID);
    expect(result).toHaveLength(1);
    expect(result[0]!.startedAt).toBe("2026-01-10T00:00:00Z");
  });
});

describe("summarizeDeployTimeline", () => {
  it("returns zero counts for empty array", () => {
    expect(summarizeDeployTimeline([])).toEqual({
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      rolledBack: 0,
      latestAt: null,
    });
  });

  it("counts each status correctly", () => {
    const rows = [
      { ...BASE_ROW, deploy_log: [makeStep({ status: "success", startedAt: "2026-01-01T04:00:00Z" })] },
      { ...BASE_ROW, id: "s2", deploy_log: [makeStep({ status: "failed", startedAt: "2026-01-01T03:00:00Z" })] },
      { ...BASE_ROW, id: "s3", deploy_log: [makeStep({ status: "skipped", startedAt: "2026-01-01T02:00:00Z" })] },
      { ...BASE_ROW, id: "s4", deploy_log: [makeStep({ status: "rolled_back", startedAt: "2026-01-01T01:00:00Z" })] },
    ];
    const summary = summarizeDeployTimeline(normalizeDeployTimeline(rows, {}, VALID));
    expect(summary.total).toBe(4);
    expect(summary.success).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.rolledBack).toBe(1);
  });

  it("latestAt is the most recent startedAt (items sorted desc)", () => {
    const rows = [
      { ...BASE_ROW, deploy_log: [makeStep({ startedAt: "2026-01-01T02:00:00Z", finishedAt: undefined })] },
      { ...BASE_ROW, id: "s2", deploy_log: [makeStep({ startedAt: "2026-01-01T05:00:00Z", finishedAt: undefined })] },
    ];
    const summary = summarizeDeployTimeline(normalizeDeployTimeline(rows, {}, VALID));
    expect(summary.latestAt).toBe("2026-01-01T05:00:00Z");
  });
});
