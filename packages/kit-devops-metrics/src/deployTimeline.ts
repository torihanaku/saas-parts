/**
 * デプロイタイムライン — submission の deploy_log を正規化・集計する純関数群。
 *
 * 実運用SaaS server/lib/autonomous-deploy/timeline.ts から抽出。
 * DeployTarget を固定 4 値から任意文字列に汎用化するため、有効 target 集合は
 * 呼び出し側が渡す（未指定なら status のみで検証）。
 */
import type { DeployStep, DeployStepStatus, DeployTarget } from "./types.js";

export interface DeployTimelineSubmissionRow {
  id: string;
  title: string | null;
  status: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  auto_deploy: boolean | null;
  deploy_log: unknown;
}

export interface DeployTimelineFilters {
  target?: DeployTarget;
  status?: DeployStepStatus;
  from?: Date;
  to?: Date;
}

export interface DeployTimelineItem {
  id: string;
  submissionId: string;
  submissionTitle: string;
  submissionStatus: string;
  autoDeploy: boolean;
  target: DeployTarget;
  status: DeployStepStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  detail: Record<string, unknown> | null;
}

export interface DeployTimelineSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  rolledBack: number;
  latestAt: string | null;
}

const DEPLOY_STATUSES = new Set<DeployStepStatus>([
  "pending",
  "running",
  "success",
  "failed",
  "skipped",
  "rolled_back",
]);

/**
 * target が有効か判定する。`validTargets` を渡すとその集合で検証し、
 * 未指定なら「空でない文字列」を有効とみなす（汎用化のためのフォールバック）。
 */
export function isDeployTarget(value: unknown, validTargets?: Set<DeployTarget>): value is DeployTarget {
  if (typeof value !== "string" || value.length === 0) return false;
  return validTargets ? validTargets.has(value) : true;
}

export function isDeployStepStatus(value: unknown): value is DeployStepStatus {
  return typeof value === "string" && DEPLOY_STATUSES.has(value as DeployStepStatus);
}

export function normalizeDeployTimeline(
  rows: DeployTimelineSubmissionRow[],
  filters: DeployTimelineFilters = {},
  validTargets?: Set<DeployTarget>,
): DeployTimelineItem[] {
  const items = rows.flatMap((row) => {
    const steps = Array.isArray(row.deploy_log) ? (row.deploy_log as DeployStep[]) : [];
    return steps.flatMap((step, index) => normalizeStep(row, step, index, validTargets));
  });

  return items
    .filter((item) => matchesFilters(item, filters))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function summarizeDeployTimeline(items: DeployTimelineItem[]): DeployTimelineSummary {
  return {
    total: items.length,
    success: items.filter((item) => item.status === "success").length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    rolledBack: items.filter((item) => item.status === "rolled_back").length,
    latestAt: items[0]?.startedAt ?? null,
  };
}

function normalizeStep(
  row: DeployTimelineSubmissionRow,
  step: DeployStep,
  index: number,
  validTargets?: Set<DeployTarget>,
): DeployTimelineItem[] {
  if (
    !isDeployTarget(step.target, validTargets) ||
    !isDeployStepStatus(step.status) ||
    !isIsoDate(step.startedAt)
  ) {
    return [];
  }

  const finishedAt = isIsoDate(step.finishedAt) ? step.finishedAt : null;
  return [
    {
      id: `${row.id}:${index}:${step.target}:${step.startedAt}`,
      submissionId: row.id,
      submissionTitle: row.title?.trim() || "Untitled submission",
      submissionStatus: row.status ?? "unknown",
      autoDeploy: row.auto_deploy === true,
      target: step.target,
      status: step.status,
      startedAt: step.startedAt,
      finishedAt,
      durationMs: finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(step.startedAt)) : null,
      error: typeof step.error === "string" ? step.error : null,
      detail: isRecord(step.detail) ? step.detail : null,
    },
  ];
}

function matchesFilters(item: DeployTimelineItem, filters: DeployTimelineFilters): boolean {
  if (filters.target && item.target !== filters.target) return false;
  if (filters.status && item.status !== filters.status) return false;

  const started = Date.parse(item.startedAt);
  if (filters.from && started < filters.from.getTime()) return false;
  if (filters.to && started > filters.to.getTime()) return false;

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
