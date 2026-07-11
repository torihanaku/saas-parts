/**
 * Challenger メトリクス集計。
 *
 * 日次で Active Learning メトリクスを計算:
 *   - challenger_proposed: その日に生成された提案数
 *   - challenger_accepted: その日に採用された提案数
 *   - hard_negative_added: その日に追加された hard negative 数
 *   - lint_accuracy: lint 予測が人間の判断と一致した割合
 *
 * 30 日ダッシュボード用のクエリ関数も提供。永続化は注入されたストアに委譲。
 */
import type { ChallengerStore } from "./stores.js";

export interface DailyMetrics {
  metricDate: string;
  challengerProposed: number;
  challengerAccepted: number;
  hardNegativeAdded: number;
  lintAccuracy: number | null;
}

export interface MetricsSummary {
  days: DailyMetrics[];
  day1vsDay30: {
    challengerAcceptanceRate: { day1: number; day30: number; delta: number };
    lintAccuracy: { day1: number | null; day30: number | null; delta: number | null };
  };
}

function isoDate(date: string): string {
  return date;
}

/** 指定日・テナントのメトリクスを集計し upsert する。 */
export async function aggregateDailyMetrics(
  tenantId: string,
  store: ChallengerStore,
  date: string = new Date().toISOString().split("T")[0]!,
): Promise<DailyMetrics> {
  const d = isoDate(date);
  const startOfDay = `${d}T00:00:00.000Z`;
  const endOfDay = `${d}T23:59:59.999Z`;

  const counts = await store.countMetrics(tenantId, startOfDay, endOfDay);

  const lintAccuracy =
    counts.lintPassed > 0 ? counts.approved / counts.lintPassed : null;

  await store.upsertDailyMetrics({
    tenant_id: tenantId,
    metric_date: d,
    challenger_proposed: counts.proposed,
    challenger_accepted: counts.accepted,
    hard_negative_added: counts.hardNegatives,
    lint_accuracy: lintAccuracy,
  });

  return {
    metricDate: d,
    challengerProposed: counts.proposed,
    challengerAccepted: counts.accepted,
    hardNegativeAdded: counts.hardNegatives,
    lintAccuracy,
  };
}

/** 30 日分のメトリクスをダッシュボード表示用に取得。 */
export async function getChallengerMetrics(
  tenantId: string,
  store: ChallengerStore,
  days: number = 30,
): Promise<MetricsSummary> {
  const rows = await store.listMetrics(tenantId, days);

  const daysData: DailyMetrics[] = rows.map((row) => ({
    metricDate: row.metric_date,
    challengerProposed: row.challenger_proposed,
    challengerAccepted: row.challenger_accepted,
    hardNegativeAdded: row.hard_negative_added,
    lintAccuracy: row.lint_accuracy,
  }));

  const day1 = daysData[0];
  const day30 = daysData[daysData.length - 1];

  const day1AcceptanceRate = day1?.challengerProposed
    ? day1.challengerAccepted / day1.challengerProposed
    : 0;
  const day30AcceptanceRate = day30?.challengerProposed
    ? day30.challengerAccepted / day30.challengerProposed
    : 0;

  return {
    days: daysData,
    day1vsDay30: {
      challengerAcceptanceRate: {
        day1: day1AcceptanceRate,
        day30: day30AcceptanceRate,
        delta: day30AcceptanceRate - day1AcceptanceRate,
      },
      lintAccuracy: {
        day1: day1?.lintAccuracy ?? null,
        day30: day30?.lintAccuracy ?? null,
        delta:
          day1?.lintAccuracy != null && day30?.lintAccuracy != null
            ? day30.lintAccuracy - day1.lintAccuracy
            : null,
      },
    },
  };
}
