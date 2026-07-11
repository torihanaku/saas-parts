import type { BlockKitPayload } from "../types";

/**
 * 週次 Firewall 精度サマリー Block Kit ビルダー。
 * 出典: dev-dashboard-v2 server/services/firewallEvalWeeklySlack.ts (#1040) の buildEvalSummaryPayload。
 *
 * ドメイン用語 (Brand Firewall / Lint F1 等) はマーケ由来。config で全て差し替え可能。
 */

/** 評価 run の 1 行 (メトリクスは 0-1 の比率、null 可)。 */
export interface EvalRun {
  lint_f1: number | null;
  lint_precision: number | null;
  lint_recall: number | null;
  lint_sample_size: number | null;
  repeat_catch_rate: number | null;
  override_retention_rate: number | null;
  threshold_violations:
    | { metric: string; value: number; threshold: number; direction: string }[]
    | null;
  generated_at: string;
}

export interface FirewallEvalCopy {
  /** 違反あり/なしの見出し絵文字。 */
  headerEmoji: { ok: string; violation: string };
  /** 見出し mrkdwn。`(emoji, tenantName, generatedAt)` を受け取る。 */
  heading: (emoji: string, tenantName: string, generatedAt: string) => string;
  /** フィールドラベル (6 メトリクス)。 */
  labels: {
    f1: string;
    precision: string;
    recall: string;
    repeatCatch: string;
    overrideRetention: string;
    sampleSize: string;
  };
  /** null メトリクスの表示。 */
  emDash: string;
  /** 違反ブロックの見出し。`count` を受け取る。 */
  violationHeading: (count: number) => string;
  /** フォールバックテキスト。`(tenantName, f1Pct, hasViolation)` を受け取る。 */
  fallbackText: (tenantName: string, f1Pct: string, hasViolation: boolean) => string;
}

export const DEFAULT_FIREWALL_EVAL_COPY: FirewallEvalCopy = {
  headerEmoji: { ok: "✅", violation: "🚨" },
  heading: (emoji, name, generatedAt) =>
    `${emoji} *Brand Firewall — 週次精度サマリー (${name})*\n最新 run: ${generatedAt}`,
  labels: {
    f1: "Lint F1",
    precision: "Precision",
    recall: "Recall",
    repeatCatch: "Repeat-catch rate",
    overrideRetention: "Override 残存率",
    sampleSize: "Sample size",
  },
  emDash: "—",
  violationHeading: (count) => `閾値違反 ${count} 件:`,
  fallbackText: (name, f1Pct, hasViolation) =>
    `Brand Firewall 週次精度サマリー (${name}) — F1=${f1Pct}${hasViolation ? " ⚠ 閾値違反あり" : ""}`,
};

/** 0-1 の比率をパーセント文字列 (例 0.83 → "83.0%") に。null は em-dash。 */
export function pct(v: number | null | undefined, emDash = "—"): string {
  if (v == null || Number.isNaN(v)) return emDash;
  return `${(v * 100).toFixed(1)}%`;
}

export function buildFirewallEvalPayload(
  tenantName: string,
  run: EvalRun,
  copy: FirewallEvalCopy = DEFAULT_FIREWALL_EVAL_COPY,
): BlockKitPayload {
  const violations = run.threshold_violations ?? [];
  const hasViolation = violations.length > 0;
  const emoji = hasViolation ? copy.headerEmoji.violation : copy.headerEmoji.ok;
  const em = copy.emDash;

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: copy.heading(emoji, tenantName, run.generated_at),
      },
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*${copy.labels.f1}:*\n${pct(run.lint_f1, em)}` },
        { type: "mrkdwn", text: `*${copy.labels.precision}:*\n${pct(run.lint_precision, em)}` },
        { type: "mrkdwn", text: `*${copy.labels.recall}:*\n${pct(run.lint_recall, em)}` },
        { type: "mrkdwn", text: `*${copy.labels.repeatCatch}:*\n${pct(run.repeat_catch_rate, em)}` },
        { type: "mrkdwn", text: `*${copy.labels.overrideRetention}:*\n${pct(run.override_retention_rate, em)}` },
        { type: "mrkdwn", text: `*${copy.labels.sampleSize}:*\n${run.lint_sample_size ?? em}` },
      ],
    },
  ];

  if (hasViolation) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${copy.violationHeading(violations.length)}*\n${violations
          .map((v) => `• \`${v.metric}\` = ${pct(v.value, em)} (閾値 ${pct(v.threshold, em)} ${v.direction})`)
          .join("\n")}`,
      },
    });
  }

  return {
    text: copy.fallbackText(tenantName, pct(run.lint_f1, em), hasViolation),
    blocks,
  };
}
