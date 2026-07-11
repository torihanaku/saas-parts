/**
 * タスクレビュー（human-in-the-loop）状態機械
 * （元: server/routes/cos/task-review.ts のロジック部。HTTP 配線は落とした）。
 *
 *   listPending — pending_review タスク一覧
 *   confirm     — pending_review → confirmed
 *   reject      — pending_review → rejected
 *   sync        — confirmed → synced（外部バックログに issue を作成して external_id 保存）
 *
 * なぜ human-in-the-loop か:
 *   LLM の action 抽出は high-recall / low-precision 設計（見逃し防止のため
 *   action らしき文を寛容に拾う）。`pending_review → confirmed/rejected` の
 *   状態機械が「外部システムに issue が作られる前に必ず人間が確認する」
 *   ガードレールになっている。
 */
import type { CosExtractedTask } from "./types";
import type { TaskStore } from "./stores";
import type { SyncOutcome, TaskSyncTarget } from "./task-sync";

export type TaskReviewErrorCode =
  | "task_not_found"
  | "invalid_status"
  | "unknown_target"
  | "sync_failed"
  | "update_failed";

export type TaskReviewResult =
  | { ok: true; id: string; status: CosExtractedTask["status"] }
  | { ok: false; code: TaskReviewErrorCode; error: string };

export type TaskSyncResult =
  | {
      ok: true;
      id: string;
      status: "synced";
      syncedTo: string;
      externalId: string;
      externalUrl: string | null;
    }
  | { ok: false; code: TaskReviewErrorCode; error: string };

export interface TaskReviewDeps {
  taskStore: TaskStore;
  /** key（例 "github" / "linear"）→ 同期先。HTTP 層の ?target= に対応する。 */
  syncTargets?: Record<string, TaskSyncTarget>;
}

export class TaskReviewService {
  private readonly deps: TaskReviewDeps;

  constructor(deps: TaskReviewDeps) {
    this.deps = deps;
  }

  async listPending(tenantId: string, limit = 200): Promise<CosExtractedTask[]> {
    return this.deps.taskStore.listPending(tenantId, limit);
  }

  async confirm(tenantId: string, id: string): Promise<TaskReviewResult> {
    return this.transition(tenantId, id, "confirmed");
  }

  async reject(tenantId: string, id: string): Promise<TaskReviewResult> {
    return this.transition(tenantId, id, "rejected");
  }

  private async transition(
    tenantId: string,
    id: string,
    next: "confirmed" | "rejected",
  ): Promise<TaskReviewResult> {
    const task = await this.deps.taskStore.getById(tenantId, id);
    if (!task) {
      return { ok: false, code: "task_not_found", error: "task_not_found" };
    }
    if (task.status !== "pending_review") {
      return {
        ok: false,
        code: "invalid_status",
        error: `cannot ${next === "confirmed" ? "confirm" : "reject"} from status=${task.status}`,
      };
    }
    const ok = await this.deps.taskStore.updateStatus(tenantId, id, { status: next });
    return ok
      ? { ok: true, id, status: next }
      : { ok: false, code: "update_failed", error: "update_failed" };
  }

  /** confirmed タスクを外部バックログへ同期し、external_id と synced を記録する。 */
  async sync(tenantId: string, id: string, targetKey: string): Promise<TaskSyncResult> {
    const target = this.deps.syncTargets?.[targetKey];
    if (!target) {
      return {
        ok: false,
        code: "unknown_target",
        error: `unknown sync target: ${targetKey}`,
      };
    }

    const task = await this.deps.taskStore.getById(tenantId, id);
    if (!task) {
      return { ok: false, code: "task_not_found", error: "task_not_found" };
    }
    if (task.status !== "confirmed") {
      return {
        ok: false,
        code: "invalid_status",
        error: "task must be confirmed before sync",
      };
    }

    const outcome: SyncOutcome = await target.sync({
      id: task.id,
      tenantId: task.tenantId,
      taskText: task.taskText,
      assigneeHint: task.assigneeHint,
      dueHint: task.dueHint,
    });
    if (!outcome.ok) {
      return { ok: false, code: "sync_failed", error: outcome.error };
    }

    const ok = await this.deps.taskStore.updateStatus(tenantId, id, {
      status: "synced",
      syncedTo: target.syncedToLabel,
      externalId: outcome.externalId,
    });
    if (!ok) {
      return { ok: false, code: "update_failed", error: "update_failed" };
    }

    return {
      ok: true,
      id,
      status: "synced",
      syncedTo: target.syncedToLabel,
      externalId: outcome.externalId,
      externalUrl: outcome.externalUrl,
    };
  }
}
