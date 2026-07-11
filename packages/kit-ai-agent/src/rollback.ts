/**
 * Rollback manager — two complementary shapes:
 *
 * 1. `createRollbackManager` — per-action rollback dispatched on the action's
 *    `rollback_strategy.type` ("delete" / "unpublish" / "revert" / "cancel" /
 *    anything you register). Only `completed` actions can be rolled back.
 *    出典: server/lib/agent/rollback-service.ts（switch 文 → ハンドラー注入）
 *
 * 2. `createSnapshotRollback` — capture-before / restore-after deployment
 *    snapshot orchestration.
 *    出典: server/services/rollbackManager.ts（jobs/snapshot 依存 → 注入）
 */
import type { AgentAction, AuditLogger, PlanStore, RollbackStrategy } from "./types";

export type RollbackHandler = (
  action: AgentAction,
  strategy: RollbackStrategy,
) => Promise<void>;

export interface RollbackManagerConfig {
  store: PlanStore;
  /** strategy.type → handler. */
  handlers: Record<string, RollbackHandler>;
  audit?: AuditLogger;
}

export interface RollbackManager {
  rollbackAction(actionId: string, requestedBy: string): Promise<void>;
}

export function createRollbackManager(config: RollbackManagerConfig): RollbackManager {
  return {
    async rollbackAction(actionId, requestedBy) {
      const action = await config.store.getAction(actionId);
      if (!action) throw new Error("action_not_found");
      if (action.status !== "completed") throw new Error("only_completed_actions_can_rollback");

      const strategy = action.rollback_strategy;
      if (!strategy || !strategy.type) throw new Error("no_rollback_strategy");

      const handler = config.handlers[strategy.type];
      if (!handler) throw new Error(`unknown_rollback_strategy: ${strategy.type}`);

      await handler(action, strategy);

      await config.store.updateAction(actionId, { status: "rolled_back" });

      await config.audit?.({
        tenantId: action.tenant_id,
        action: "agent_action_rolled_back",
        resourceType: "agent_action",
        resourceId: actionId,
        riskLevel: "high",
        actor: requestedBy,
        changes: { status: "rolled_back", strategy: strategy.type },
      });
    },
  };
}

// ─── Snapshot-based deployment rollback ──────────────────────────────────────

export interface SnapshotProvider {
  /** Capture state before external changes; returns a snapshot key. */
  capture(tenantId: string, deployId: string): Promise<string>;
  /** Restore state from a snapshot; returns number of restored records. */
  restore(tenantId: string, snapshotKey: string): Promise<number>;
}

export interface SnapshotRollback {
  prepareDeployment(tenantId: string, deployId: string): Promise<string>;
  executeRollback(
    tenantId: string,
    deployId: string,
    snapshotKey: string,
  ): Promise<{ restored: number }>;
}

export function createSnapshotRollback(provider: SnapshotProvider): SnapshotRollback {
  return {
    async prepareDeployment(tenantId, deployId) {
      return provider.capture(tenantId, deployId);
    },
    async executeRollback(tenantId, _deployId, snapshotKey) {
      const restored = await provider.restore(tenantId, snapshotKey);
      return { restored };
    },
  };
}
