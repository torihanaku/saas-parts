/**
 * Tests for timeline (ported from 実運用SaaS autonomous-deploy-timeline.test.ts).
 * 純粋関数（normalize / summarize）のみを対象とし、HTTP ルート部は移植対象外。
 */
import { describe, expect, it } from "vitest";

import {
  normalizeDeployTimeline,
  summarizeDeployTimeline,
  isDeployTarget,
  isDeployStepStatus,
} from "./timeline";

describe("normalizeDeployTimeline", () => {
  it("normalizes deploy_log steps newest first and summarizes statuses", () => {
    const items = normalizeDeployTimeline([
      {
        id: "sub-1",
        title: "Campaign A",
        status: "approved",
        submitted_at: "2026-05-06T10:00:00.000Z",
        decided_at: null,
        auto_deploy: true,
        deploy_log: [
          {
            target: "cms",
            status: "success",
            startedAt: "2026-05-06T10:01:00.000Z",
            finishedAt: "2026-05-06T10:01:01.500Z",
            detail: { platform: "wordpress" },
          },
          {
            target: "sns",
            status: "failed",
            startedAt: "2026-05-06T10:03:00.000Z",
            finishedAt: "2026-05-06T10:03:02.000Z",
            error: "rate_limited",
          },
        ],
      },
    ]);

    expect(items.map((item) => item.target)).toEqual(["sns", "cms"]);
    expect(items[1]).toMatchObject({
      submissionTitle: "Campaign A",
      durationMs: 1500,
      autoDeploy: true,
    });
    expect(summarizeDeployTimeline(items)).toMatchObject({
      total: 2,
      success: 1,
      failed: 1,
    });
  });

  it("drops steps with invalid target/status/date", () => {
    const items = normalizeDeployTimeline([
      {
        id: "sub-2",
        title: null,
        status: "approved",
        submitted_at: null,
        decided_at: null,
        auto_deploy: false,
        deploy_log: [
          { target: "email", status: "success", startedAt: "2026-05-06T10:00:00.000Z" },
          { target: "seo", status: "bogus", startedAt: "2026-05-06T10:00:00.000Z" },
          { target: "seo", status: "success", startedAt: "not-a-date" },
        ] as unknown as [],
      },
    ]);
    expect(items).toHaveLength(0);
  });

  it("applies target and status filters", () => {
    const rows = [
      {
        id: "sub-1",
        title: "A",
        status: "approved",
        submitted_at: null,
        decided_at: null,
        auto_deploy: true,
        deploy_log: [
          { target: "cms", status: "success", startedAt: "2026-05-06T10:01:00.000Z" },
          { target: "sns", status: "failed", startedAt: "2026-05-06T10:03:00.000Z" },
        ],
      },
    ];
    const filtered = normalizeDeployTimeline(rows, { target: "sns", status: "failed" });
    expect(filtered).toEqual([expect.objectContaining({ target: "sns", status: "failed" })]);
  });
});

describe("guards", () => {
  it("isDeployTarget", () => {
    expect(isDeployTarget("seo")).toBe(true);
    expect(isDeployTarget("email")).toBe(false);
  });
  it("isDeployStepStatus", () => {
    expect(isDeployStepStatus("rolled_back")).toBe(true);
    expect(isDeployStepStatus("bogus")).toBe(false);
  });
});
