/**
 * Pre-deployment snapshot capture / restore contracts.
 *
 * Captures a tenant's current state before a deployment so a 1-click rollback
 * can restore (or at least document the restore decision for) that state.
 * All I/O is injected: the state source (what to snapshot), the snapshot store
 * (where the serialized state goes) and the decision log (audit trail of the
 * rollback) are structural interfaces the caller implements.
 *
 * Boundary note: agent-action rollback (per-action rollback_strategy —
 * delete / unpublish / revert / cancel) is intentionally NOT part of this
 * package; that lives in the ai-agent kit. This package covers only the
 * generic pre-deploy state snapshot and its restore decision contract.
 */

/** 何をスナップショットするか（例: brand DNA / content performance の現況行）。 */
export interface SnapshotStateSource {
  fetchState(tenantId: string): Promise<unknown[]>;
}

/** シリアライズ済みスナップショットの置き場（GCS/S3/ローカル等）。 */
export interface SnapshotStore {
  put(key: string, content: string): Promise<void>;
}

export interface RollbackDecisionEntry {
  tenant_id: string;
  decision_type: "stop";
  subject: string;
  context: string;
  reason: string;
  source: "manual";
  resource_type: "snapshot";
  resource_id: string;
  metadata: Record<string, unknown>;
}

/** ロールバック実施の監査証跡（decision log）。 */
export interface DecisionLogStore {
  insert(entry: RollbackDecisionEntry): Promise<void>;
}

export interface DeploymentSnapshotDeps {
  stateSource: SnapshotStateSource;
  decisionLog: DecisionLogStore;
  /**
   * 省略可。元実装はアップロードをシミュレートしていた（キー生成＋ログのみ）。
   * 指定するとシリアライズした状態を実際に永続化する。
   */
  snapshotStore?: SnapshotStore;
  /** ログ出力先。省略時 console.warn（元実装準拠）。 */
  warn?: (message: string) => void;
  /** 時刻源（テスト用）。省略時 Date.now。 */
  now?: () => number;
}

export interface DeploymentSnapshot {
  /**
   * Captures a pre-deployment state snapshot for rollback safety.
   * Returns the snapshot key (`snapshots/<tenantId>/<deployId>-<ts>.json`).
   */
  capturePreDeploySnapshot(tenantId: string, deployId: string): Promise<string>;
  /** Reverts to a previous snapshot (records the decision-log entry). */
  rollbackFromSnapshot(tenantId: string, snapshotKey: string): Promise<void>;
}

export function createDeploymentSnapshot(deps: DeploymentSnapshotDeps): DeploymentSnapshot {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const now = deps.now ?? Date.now;

  async function capturePreDeploySnapshot(
    tenantId: string,
    deployId: string
  ): Promise<string> {
    // 1. Fetch current state (e.g. content_performance, brand_dna, etc.)
    const currentState = await deps.stateSource.fetchState(tenantId);

    // 2. Serialize and (optionally) persist to the injected store
    const snapshotData = JSON.stringify(currentState);
    const snapshotKey = `snapshots/${tenantId}/${deployId}-${now()}.json`;

    if (deps.snapshotStore) {
      await deps.snapshotStore.put(snapshotKey, snapshotData);
    }

    warn(`[Snapshot] Pre-deploy snapshot captured for ${deployId}: ${snapshotKey}`);

    return snapshotKey;
  }

  async function rollbackFromSnapshot(
    tenantId: string,
    snapshotKey: string
  ): Promise<void> {
    warn(`[Rollback] Reverting tenant ${tenantId} using snapshot ${snapshotKey}`);

    await deps.decisionLog.insert({
      tenant_id: tenantId,
      decision_type: "stop",
      subject: `System Rollback: ${snapshotKey}`,
      context: `User initiated 1-click rollback`,
      reason: "Rollback requested by admin",
      source: "manual",
      resource_type: "snapshot",
      resource_id: snapshotKey.split("/").pop() || snapshotKey,
      metadata: { method: "1-click-rollback", snapshot_key: snapshotKey },
    });
  }

  return { capturePreDeploySnapshot, rollbackFromSnapshot };
}
