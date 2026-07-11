/**
 * Slack Block Kit 承認通知（メッセージ構築 + 送信）。
 *
 * 変更点（移植元: dev-dashboard-v2 server/lib/firewall/slack-notifier.ts）:
 * - 承認ワークフロー固有の文言（"新企画案" / "Firewall Lint" / action_id の
 *   firewall_ プレフィックス等）→ `copy` パラメータで注入（デフォルトは汎用文言）
 * - Supabase / Claude 依存のオーケストレーション（triage 生成・永続化）→ 対象外。
 *   呼び出し側が rejectOptions を組み立てて渡す
 * - fetch → 注入可能（default: globalThis.fetch）、ログ → 注入可能
 * - 署名検証は本パッケージに含めない（→ kit-approval-workflow が担当）
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BlockKitPayload {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

interface SlackLookupResponse {
  ok: boolean;
  user?: { id?: string };
  error?: string;
}

interface SlackPostResponse {
  ok: boolean;
  error?: string;
}

export interface NotifierDeps {
  fetchImpl?: FetchLike;
  logWarn?: (payload: Record<string, unknown>) => void;
  logError?: (payload: Record<string, unknown>) => void;
}

function deps(d: NotifierDeps = {}): Required<NotifierDeps> {
  return {
    fetchImpl: d.fetchImpl ?? ((input, init) => fetch(input, init)),
    logWarn: d.logWarn ?? ((p) => console.warn(JSON.stringify({ severity: "WARNING", ...p }))),
    logError: d.logError ?? ((p) => console.error(JSON.stringify({ severity: "ERROR", ...p }))),
  };
}

// ─── Slack API ──────────────────────────────────────────────────────────────

/** email から Slack ユーザーIDを引く（`users.lookupByEmail`）。失敗時 null。 */
export async function resolveSlackUserIdByEmail(
  email: string,
  slackToken: string,
  notifierDeps?: NotifierDeps,
): Promise<string | null> {
  const { fetchImpl, logWarn } = deps(notifierDeps);
  const lookupRes = await fetchImpl(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${slackToken}` },
  });
  const lookupData = await lookupRes.json() as SlackLookupResponse;
  if (!lookupRes.ok || !lookupData.ok || !lookupData.user?.id) {
    logWarn({
      message: "slack_user_lookup_failed",
      email,
      status: lookupRes.status,
      error: lookupData.error,
    });
    return null;
  }
  return lookupData.user.id;
}

/** チャンネル（またはユーザーID）へ Block Kit ペイロードを送信する。 */
export async function postSlackDm(
  channel: string,
  payload: BlockKitPayload,
  slackToken: string,
  notifierDeps?: NotifierDeps,
): Promise<boolean> {
  const { fetchImpl, logError } = deps(notifierDeps);
  const sendRes = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, ...payload }),
  });
  const sendData = await sendRes.json() as SlackPostResponse;
  if (!sendRes.ok || !sendData.ok) {
    logError({
      message: "slack_dm_send_failed",
      channel,
      status: sendRes.status,
      error: sendData.error,
    });
    return false;
  }
  return true;
}

/**
 * email で承認者を解決して DM を送る小さなオーケストレータ
 * （移植元 notifyApprover の汎用部分。triage 生成・DB 永続化は呼び出し側の責務）。
 */
export async function notifyByEmail(
  email: string,
  payload: BlockKitPayload,
  slackToken: string,
  notifierDeps?: NotifierDeps,
): Promise<boolean> {
  const slackUserId = await resolveSlackUserIdByEmail(email, slackToken, notifierDeps);
  if (!slackUserId) return false;
  return postSlackDm(slackUserId, payload, slackToken, notifierDeps);
}

// ─── Approval message builder ───────────────────────────────────────────────

export interface ApprovalSubmission {
  id: string;
  tenantId: string;
  submitterId: string;
  approverId: string | null;
  title: string;
  contentText: string;
}

export interface RiskAssessment {
  riskScore: number;
  summary: string;
}

export interface RejectOption {
  code: string;
  label: string;
}

export interface AlternativeProposal {
  /** 逸脱軸（どの観点を変えた代替案か） */
  deviationAxis: string;
  /** 推定リスク */
  estimatedRisk: string;
  content: string;
  /** 狙い（期待アップサイド） */
  hypothesizedUpside: string;
}

export interface ApprovalCopy {
  /** 冒頭見出し */
  headline: string;
  /** 起案者ラベル */
  submitterLabel: string;
  /** タイトルラベル */
  titleLabel: string;
  /** リスクチェック結果ラベル */
  riskResultLabel: string;
  /** 本文引用の見出し */
  mainProposalLabel: string;
  /** 代替案セクション見出し */
  alternativesHeading: string;
  /** 想定却下理由のラベル */
  expectedRejectionLabel: string;
  /** 承認ボタン */
  approveLabel: string;
  /** 却下ボタン */
  rejectLabel: string;
  /** 通知テキスト（プッシュ通知等に出る text フィールド）の接頭辞 */
  notificationTextPrefix: string;
  /** actions ブロックの block_id 接頭辞 */
  actionsBlockIdPrefix: string;
  /** 承認ボタンの action_id */
  approveActionId: string;
  /** 却下ボタンの action_id */
  rejectActionId: string;
}

export const DEFAULT_APPROVAL_COPY: ApprovalCopy = {
  headline: "新しい承認依頼があります",
  submitterLabel: "起案者",
  titleLabel: "タイトル",
  riskResultLabel: "リスクチェック結果:",
  mainProposalLabel: "【本命案】",
  alternativesHeading: "*🎯 チャレンジャー案*",
  expectedRejectionLabel: "想定される却下理由:",
  approveLabel: "承認する",
  rejectLabel: "却下する",
  notificationTextPrefix: "【要承認】",
  actionsBlockIdPrefix: "approval_actions_",
  approveActionId: "approval_approve",
  rejectActionId: "approval_reject_open",
};

/**
 * Block Kit payload for the approval message.
 * actions: [Approve (primary)] [Reject — opens modal].
 * The reject button carries pre-generated rejectOptions in `value` so the
 * interaction handler can populate the modal radio without re-running AI.
 */
export function buildApprovalBlockKit(
  submission: ApprovalSubmission,
  risk: RiskAssessment,
  rejectOptions: RejectOption[],
  alternatives?: AlternativeProposal[],
  copyOverrides?: Partial<ApprovalCopy>,
): BlockKitPayload {
  const copy: ApprovalCopy = { ...DEFAULT_APPROVAL_COPY, ...copyOverrides };
  const severityEmoji =
    risk.riskScore > 40 ? "🔴" : risk.riskScore > 0 ? "⚠️" : "✅";

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${copy.headline}*\n${copy.submitterLabel}: <@${submission.submitterId}>\n${copy.titleLabel}: *${submission.title}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${copy.riskResultLabel}* ${severityEmoji} Risk Score: ${risk.riskScore}\n${risk.summary}`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${copy.mainProposalLabel}:\n> ${submission.contentText.substring(0, 200)}${submission.contentText.length > 200 ? "…" : ""}`,
      },
    },
  ];

  if (alternatives && alternatives.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: copy.alternativesHeading },
    });
    alternatives.forEach((c, index) => {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*案${String.fromCharCode(66 + index)}* (${c.deviationAxis} - リスク: ${c.estimatedRisk})\n> ${c.content.substring(0, 200)}…\n_狙い: ${c.hypothesizedUpside}_`,
        },
      });
    });
  }

  if (rejectOptions.length > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${copy.expectedRejectionLabel}* ${rejectOptions.map((o) => `\`${o.label}\``).join(" / ")}`,
        },
      ],
    });
  }

  blocks.push({
    type: "actions",
    block_id: `${copy.actionsBlockIdPrefix}${submission.id}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: copy.approveLabel },
        style: "primary",
        action_id: copy.approveActionId,
        value: JSON.stringify({
          submissionId: submission.id,
          approverId: submission.approverId,
          tenantId: submission.tenantId,
        }),
      },
      {
        type: "button",
        text: { type: "plain_text", text: copy.rejectLabel },
        style: "danger",
        action_id: copy.rejectActionId,
        value: JSON.stringify({
          submissionId: submission.id,
          approverId: submission.approverId,
          tenantId: submission.tenantId,
          options: rejectOptions,
        }),
      },
    ],
  });

  return {
    text: `${copy.notificationTextPrefix}${submission.title}`,
    blocks,
  };
}

// ─── Reject modal builder ───────────────────────────────────────────────────

export interface RejectModalContext {
  submissionId: string;
  approverId: string;
  tenantId: string;
}

export interface RejectModalCopy {
  callbackId: string;
  title: string;
  submitLabel: string;
  closeLabel: string;
  reasonLabel: string;
  freetextLabel: string;
  /** "その他" フォールバック選択肢 */
  fallbackOption: RejectOption;
  reasonBlockId: string;
  reasonActionId: string;
  freetextBlockId: string;
  freetextActionId: string;
  freetextMaxLength: number;
}

export const DEFAULT_REJECT_MODAL_COPY: RejectModalCopy = {
  callbackId: "approval_reject_modal",
  title: "却下理由を選択",
  submitLabel: "却下を確定",
  closeLabel: "キャンセル",
  reasonLabel: "却下の主な理由",
  freetextLabel: "補足 (任意 / 「その他」選択時は必須)",
  fallbackOption: { code: "other", label: "その他（自由記述）" },
  reasonBlockId: "reason_block",
  reasonActionId: "reason_choice",
  freetextBlockId: "freetext_block",
  freetextActionId: "freetext",
  freetextMaxLength: 500,
};

/**
 * Modal view shown when the reject button is clicked. Radio with the 2-3
 * pre-generated options + fallback (free text) and an optional
 * plain_text_input for the rationale.
 * Submit -> view_submission with callback_id=copy.callbackId.
 */
export function buildRejectModalView(
  context: RejectModalContext,
  rejectOptions: RejectOption[],
  copyOverrides?: Partial<RejectModalCopy>,
): Record<string, unknown> {
  const copy: RejectModalCopy = { ...DEFAULT_REJECT_MODAL_COPY, ...copyOverrides };
  const allOptions = [...rejectOptions.slice(0, 3), copy.fallbackOption];

  return {
    type: "modal",
    callback_id: copy.callbackId,
    private_metadata: JSON.stringify(context),
    title: { type: "plain_text", text: copy.title },
    submit: { type: "plain_text", text: copy.submitLabel },
    close: { type: "plain_text", text: copy.closeLabel },
    blocks: [
      {
        type: "input",
        block_id: copy.reasonBlockId,
        label: { type: "plain_text", text: copy.reasonLabel },
        element: {
          type: "radio_buttons",
          action_id: copy.reasonActionId,
          options: allOptions.map((o) => ({
            text: { type: "plain_text", text: o.label },
            value: o.code,
          })),
        },
      },
      {
        type: "input",
        block_id: copy.freetextBlockId,
        optional: true,
        label: { type: "plain_text", text: copy.freetextLabel },
        element: {
          type: "plain_text_input",
          action_id: copy.freetextActionId,
          multiline: true,
          max_length: copy.freetextMaxLength,
        },
      },
    ],
  };
}
