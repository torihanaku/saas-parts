import { beforeEach, describe, expect, it } from "vitest";
import { TaskReviewService } from "./task-review";
import { InMemoryTaskStore } from "./stores";
import type { TaskSyncTarget } from "./task-sync";

const okTarget: TaskSyncTarget = {
  syncedToLabel: "github_issue",
  sync: async () => ({ ok: true, externalId: "42", externalUrl: "https://gh/42" }),
};

const failTarget: TaskSyncTarget = {
  syncedToLabel: "linear",
  sync: async () => ({ ok: false, error: "integration_not_configured" }),
};

describe("TaskReviewService", () => {
  let store: InMemoryTaskStore;
  let svc: TaskReviewService;
  let taskId: string;

  beforeEach(async () => {
    store = new InMemoryTaskStore();
    svc = new TaskReviewService({
      taskStore: store,
      syncTargets: { github: okTarget, linear: failTarget },
    });
    const r = await store.insert({
      tenantId: "t1",
      digestItemId: null,
      taskText: "LP改修",
      assigneeHint: null,
      dueHint: null,
      status: "pending_review",
    });
    taskId = (r as { ok: true; id: string }).id;
  });

  it("listPending は pending_review のみ返す", async () => {
    await store.updateStatus("t1", taskId, { status: "confirmed" });
    expect(await svc.listPending("t1")).toHaveLength(0);
  });

  it("confirm: pending_review → confirmed", async () => {
    const res = await svc.confirm("t1", taskId);
    expect(res).toEqual({ ok: true, id: taskId, status: "confirmed" });
    expect((await store.getById("t1", taskId))!.status).toBe("confirmed");
  });

  it("reject: pending_review → rejected", async () => {
    const res = await svc.reject("t1", taskId);
    expect(res).toEqual({ ok: true, id: taskId, status: "rejected" });
  });

  it("pending_review 以外からの confirm/reject は invalid_status", async () => {
    await svc.confirm("t1", taskId);
    const res = await svc.confirm("t1", taskId);
    expect(res).toMatchObject({ ok: false, code: "invalid_status" });
    const res2 = await svc.reject("t1", taskId);
    expect(res2).toMatchObject({ ok: false, code: "invalid_status" });
  });

  it("存在しない ID / 他テナントは task_not_found", async () => {
    expect(await svc.confirm("t1", "nope")).toMatchObject({ ok: false, code: "task_not_found" });
    expect(await svc.confirm("t2", taskId)).toMatchObject({ ok: false, code: "task_not_found" });
  });

  it("sync は confirmed からのみ（human-in-the-loop ガード）", async () => {
    const res = await svc.sync("t1", taskId, "github");
    expect(res).toMatchObject({ ok: false, code: "invalid_status" });
  });

  it("sync 成功: synced + external_id + syncedToLabel が保存される", async () => {
    await svc.confirm("t1", taskId);
    const res = await svc.sync("t1", taskId, "github");
    expect(res).toEqual({
      ok: true,
      id: taskId,
      status: "synced",
      syncedTo: "github_issue",
      externalId: "42",
      externalUrl: "https://gh/42",
    });
    const task = (await store.getById("t1", taskId))!;
    expect(task.status).toBe("synced");
    expect(task.syncedTo).toBe("github_issue");
    expect(task.externalId).toBe("42");
  });

  it("sync 失敗時は status を変えない（fail-closed）", async () => {
    await svc.confirm("t1", taskId);
    const res = await svc.sync("t1", taskId, "linear");
    expect(res).toMatchObject({ ok: false, code: "sync_failed" });
    expect((await store.getById("t1", taskId))!.status).toBe("confirmed");
  });

  it("未登録ターゲットは unknown_target", async () => {
    await svc.confirm("t1", taskId);
    expect(await svc.sync("t1", taskId, "jira")).toMatchObject({
      ok: false,
      code: "unknown_target",
    });
  });
});
