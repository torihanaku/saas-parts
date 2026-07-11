/**
 * @torihanaku/kit-devops-metrics
 *
 * 開発組織メトリクス＆デプロイ運用の汎用コア。
 * dev-dashboard-v2 の dora / deploy-* / git-workspace / autonomous-deploy から抽出。
 * GitHub API は GitProvider、永続化は注入 store、Slack 通知は注入コールバックに置換。
 */

export type {
  RepoRef,
  WorkflowRun,
  DoraLevel,
  DoraMetrics,
  DeployStatus,
  CheckStatus,
  OverallStatus,
  DeployReachResult,
  SilentFailureCheckConfig,
  SilentFailureCheck,
  SilentFailuresResult,
  DeployTarget,
  DeployStepStatus,
  DeployStep,
  SubmissionRecord,
  DeployAdapterResult,
  DeployAdapter,
  OrchestratorRunResult,
  GitFileStatus,
  GitWorkspaceState,
} from "./types.js";

export {
  createGitHubProvider,
  type GitProvider,
  type GitHubProviderOptions,
  type GitCommitSummary,
  type GitRelease,
  type GitPullRequest,
  type GitIssue,
  type ListWorkflowRunsParams,
} from "./gitProvider.js";

export {
  isoWeek,
  avg,
  round2,
  classifyLevel,
  computeDoraMetrics,
  calculateDoraMetrics,
} from "./dora.js";

export {
  deployStatus,
  getDeployReach,
  checkStatus,
  worstStatus,
  getSilentFailures,
  type DeployReachOptions,
  type LastActivityProvider,
} from "./deployHealth.js";

export {
  isDeployTarget,
  isDeployStepStatus,
  normalizeDeployTimeline,
  summarizeDeployTimeline,
  type DeployTimelineSubmissionRow,
  type DeployTimelineFilters,
  type DeployTimelineItem,
  type DeployTimelineSummary,
} from "./deployTimeline.js";

export {
  runAutonomousDeploy,
  type SubmissionStore,
  type AuditLogger,
  type DeployNotifier,
  type RunAutonomousDeployOptions,
  type OrchestratorDeps,
} from "./deployOrchestrator.js";

export {
  parsePorcelain,
  InMemoryGitWorkspaceStore,
  type GitWorkspaceInput,
} from "./gitWorkspace.js";

export {
  DeployController,
  type DeployControlConfig,
  type DeployControlStatus,
} from "./deployControl.js";

export {
  useGitHubCommits,
  useGitHubWorkflows,
  checkBackendHealth,
  type ClientRepoRef,
  type GitCommit,
  type WorkflowRunView,
  type UseGitHubOptions,
} from "./client/useGitHub.js";
