import { describe, expect, it, vi } from "vitest";
import {
  buildIssueBody,
  createGithubSyncTarget,
  createLinearSyncTarget,
  syncTaskToGithub,
  syncTaskToLinear,
  type TaskSyncContext,
} from "./task-sync";
import { createLinearIssue } from "./linear-client";
import type { FetchLike } from "./types";

const task: TaskSyncContext = {
  id: "task-1",
  tenantId: "t1",
  taskText: "LP のヒーローコピーを A/B テストする",
  assigneeHint: "@田中",
  dueHint: "来週金曜",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildIssueBody", () => {
  it("productName をパラメータ化できる（既定は AI Chief of Staff）", () => {
    expect(buildIssueBody(task)).toContain("_Imported from AI Chief of Staff._");
    expect(buildIssueBody(task, "MyProduct COS")).toContain("_Imported from MyProduct COS._");
  });

  it("hint が無い行は省略される", () => {
    const body = buildIssueBody({ ...task, assigneeHint: null, dueHint: null });
    expect(body).not.toContain("Assignee hint");
    expect(body).not.toContain("Due hint");
    expect(body).toContain("**Task**: LP のヒーローコピーを A/B テストする");
  });
});

describe("syncTaskToGithub", () => {
  it("クレデンシャル未設定は fail-closed", async () => {
    expect(await syncTaskToGithub(task, {})).toEqual({
      ok: false,
      error: "integration_not_configured",
    });
  });

  it("成功時は issue number + html_url を返す", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      expect(String(url)).toBe("https://api.github.com/repos/acme/backlog/issues");
      const payload = JSON.parse(String(init?.body)) as {
        title: string;
        labels: string[];
      };
      expect(payload.title).toBe("[COS] LP のヒーローコピーを A/B テストする");
      expect(payload.labels).toContain("tenant:t1");
      return jsonResponse({ number: 42, html_url: "https://github.com/acme/backlog/issues/42" });
    });
    const res = await syncTaskToGithub(task, {
      token: "gh-token",
      repo: "acme/backlog",
      fetchImpl,
    });
    expect(res).toEqual({
      ok: true,
      externalId: "42",
      externalUrl: "https://github.com/acme/backlog/issues/42",
    });
  });

  it("HTTP エラーは ok:false", async () => {
    const res = await syncTaskToGithub(task, {
      token: "x",
      repo: "a/b",
      fetchImpl: async () => new Response("forbidden", { status: 403 }),
    });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("github 403");
  });

  it("number 無し応答は ok:false", async () => {
    const res = await syncTaskToGithub(task, {
      token: "x",
      repo: "a/b",
      fetchImpl: async () => jsonResponse({}),
    });
    expect(res).toEqual({ ok: false, error: "github returned no issue number" });
  });
});

describe("createLinearIssue / syncTaskToLinear", () => {
  const successBody = {
    data: {
      issueCreate: {
        success: true,
        issue: { id: "uuid", identifier: "MKT-12", url: "https://linear.app/i/MKT-12" },
      },
    },
  };

  it("成功時は identifier + url", async () => {
    const issue = await createLinearIssue(
      { apiKey: "k", teamId: "team", title: "t", description: "d" },
      async () => jsonResponse(successBody),
    );
    expect(issue).toEqual({ id: "MKT-12", url: "https://linear.app/i/MKT-12" });
  });

  it("apiKey / teamId / title 欠落は null", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    expect(
      await createLinearIssue({ apiKey: "", teamId: "t", title: "a", description: "" }, fetchImpl),
    ).toBeNull();
    expect(
      await createLinearIssue({ apiKey: "k", teamId: "", title: "a", description: "" }, fetchImpl),
    ).toBeNull();
    expect(
      await createLinearIssue({ apiKey: "k", teamId: "t", title: "  ", description: "" }, fetchImpl),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("GraphQL errors / success:false / ネットワーク例外は null", async () => {
    const base = { apiKey: "k", teamId: "t", title: "a", description: "" };
    expect(
      await createLinearIssue(base, async () => jsonResponse({ errors: [{ message: "bad" }] })),
    ).toBeNull();
    expect(
      await createLinearIssue(base, async () =>
        jsonResponse({ data: { issueCreate: { success: false } } }),
      ),
    ).toBeNull();
    expect(
      await createLinearIssue(base, async () => {
        throw new Error("network");
      }),
    ).toBeNull();
  });

  it("syncTaskToLinear: 未設定 fail-closed / 失敗は linear_create_failed", async () => {
    expect(await syncTaskToLinear(task, {})).toEqual({
      ok: false,
      error: "integration_not_configured",
    });
    const res = await syncTaskToLinear(task, {
      apiKey: "k",
      teamId: "t",
      fetchImpl: async () => new Response("err", { status: 500 }),
    });
    expect(res).toEqual({ ok: false, error: "linear_create_failed" });
  });
});

describe("sync target ファクトリ", () => {
  it("syncedToLabel が付与される", () => {
    expect(createGithubSyncTarget({}).syncedToLabel).toBe("github_issue");
    expect(createLinearSyncTarget({}).syncedToLabel).toBe("linear");
  });
});
