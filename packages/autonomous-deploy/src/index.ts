/**
 * @torihanaku/autonomous-deploy — 自律デプロイオーケストレーション
 *
 * 承認済みコンテンツを複数チャネルへ段階的にデプロイし、各試行をタイムラインに
 * 記録、後段失敗時は完了ステップを巻き戻す（compensating rollback）。
 *
 * すべての外部境界（submission ストア / アダプタレジストリ / feature flag /
 * 監査 / 通知）は注入式。アダプタは registry（`AdapterRegistry`）に登録する。
 * SEO アダプタ（`SeoAdapter`）を実装例として同梱。
 *
 * 承認ゲート: submission.status === "approved" && auto_deploy を確認する組込み
 * ゲートを保持。より本格的な承認ワークフローは @torihanaku/kit-approval-workflow が
 * 充足する（本パッケージは import しない）。
 */

// Orchestrator
export { runAutonomousDeploy } from "./orchestrator";
export type {
  RunAutonomousDeployOptions,
  AutonomousDeployConfig,
  AdapterRegistry,
  DeployStore,
  AuditFn,
  NotifyFn,
  Logger,
} from "./orchestrator";

// Store
export { InMemoryDeployStore } from "./store";

// Shared types
export type {
  DeployAdapter,
  DeployAdapterResult,
  DeployStep,
  DeployStepStatus,
  DeployTarget,
  DeployContext,
  OrchestratorRunResult,
  SubmissionRecord,
} from "./types";

// SEO adapter (example)
export { SeoAdapter, buildSeoIndexingPayload } from "./adapters/seo-adapter";
export type {
  SeoAdapterConfig,
  SeoPlatform,
  SeoTargetRow,
  IndexingNotificationType,
  ProxyRequestFn,
  LoadSeoTargets,
} from "./adapters/seo-adapter";

// Timeline
export {
  normalizeDeployTimeline,
  summarizeDeployTimeline,
  isDeployTarget,
  isDeployStepStatus,
} from "./timeline";
export type {
  DeployTimelineItem,
  DeployTimelineSummary,
  DeployTimelineFilters,
  DeployTimelineSubmissionRow,
} from "./timeline";
