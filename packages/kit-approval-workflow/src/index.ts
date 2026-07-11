/**
 * @torihanaku/kit-approval-workflow
 *
 * 承認ワークフロー (申請→リスク評価→承認→監査) の汎用コア。
 * dev-dashboard-v2 の firewall / ringi システムから抽出。
 */
export type {
  SubmissionStatus,
  Submission,
  RiskEvaluation,
  DecisionAction,
  ExceptionRequest,
  AuditEntry,
  AuditLogger,
  TriageOption,
} from "./types.js";

export {
  InMemorySubmissionStore,
  InMemoryExceptionRequestStore,
  type SubmissionStore,
  type ExceptionRequestStore,
  type SubmissionListFilter,
} from "./stores.js";

export {
  ApprovalWorkflow,
  type ApprovalWorkflowDeps,
  type RiskEvaluator,
  type ApproverNotifier,
  type SubmitInput,
  type DecideInput,
  type ReapplyFix,
  type SubmitExceptionInput,
  type DecideExceptionInput,
  type WorkflowErrorCode,
  type WorkflowResult,
} from "./workflow.js";

export {
  classifyRisk,
  DEFAULT_RISK_TIER_CONFIG,
  type AgentAction,
  type RiskTier,
  type RiskTierConfig,
} from "./riskTier.js";

export {
  aggregate,
  type ApprovalDecision,
  type ApprovalResponse,
  type ApprovalMode,
  type AggregateFinalStatus,
  type AggregateResult,
} from "./approvalAggregator.js";

export {
  runEscalationJob,
  DEFAULT_PENDING_STATUSES,
  DEFAULT_ESCALATION_TIMEOUT_HOURS,
  type EscalationPolicy,
  type EscalationPolicyResolver,
  type EscalationNotifier,
  type EscalationJobDeps,
} from "./escalation.js";

export { verifySlackSignature } from "./slackSignature.js";

export {
  dispatchInteraction,
  handleSlackInteractionRequest,
  buildRejectModalView,
  createHttpSlackViewOpener,
  REJECT_MODAL_CALLBACK_ID,
  APPROVE_ACTION_ID,
  REJECT_OPEN_ACTION_ID,
  type SlackInteractionPayload,
  type BlockActionsPayload,
  type ViewSubmissionPayload,
  type ApproveButtonValue,
  type RejectOpenButtonValue,
  type RejectModalContext,
  type ActionResult,
  type SlackViewOpener,
  type SlackInteractionHandlers,
  type SlackInteractionRequestOptions,
} from "./slackInteractions.js";

export {
  createApprovalHttpAdapter,
  type ApprovalHttpAdapter,
  type ApprovalHttpAdapterOptions,
  type AuthedUser,
} from "./adapters/http.js";
