/**
 * Anomaly detection helpers for the realtime monitoring job.
 *
 * Each detector compares a recent observed value against a rolling baseline
 * and returns an `AnomalyResult` when a threshold is breached. Detectors must
 * never throw — when source tables or data are missing they return `null` so
 * the orchestrator can skip gracefully.
 *
 * 変更点（移植元: 実運用SaaS server/lib/anomaly-detection.ts）:
 * - Supabase クエリ直書き → `fetchRows(tenantId, range)` 注入
 *   （null 返却 = ソーステーブル欠如としてスキップ。元実装の missing-table 分岐相当）
 * - 検出器名を汎用リネーム: cpa_spike → metric_spike / email_delivery_drop →
 *   delivery_drop / seo_rank_drop → rank_drop（計算ロジック・閾値は同一）
 * - 定数閾値 → ファクトリオプション（デフォルトは移植元と同値）
 * - `new Date()` → `now` 注入可（テストの決定性向上。default は実時刻）
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type AnomalySeverity = "warning" | "critical";

export interface AnomalyResult {
  metricType: string;
  severity: AnomalySeverity;
  observedValue: number;
  baselineValue?: number;
  threshold: number;
  details?: Record<string, unknown>;
}

/** テナント単位の異常検出関数。異常なし/データ不足時は null。 */
export type Detector = (tenantId: string) => Promise<AnomalyResult | null>;

/** 日付範囲（両端含む）。日次系は YYYY-MM-DD、時刻系は ISO 8601。 */
export interface DateRange {
  start: string;
  end: string;
}

/**
 * 行の取得関数。`null` を返すとソーステーブル欠如としてスキップ（detector は null）。
 * 例外を投げた場合も detector は null を返す。
 */
export type FetchRows<Row> = (tenantId: string, range: DateRange) => Promise<Row[] | null>;

// ─── Shared helpers ─────────────────────────────────────────────────────────

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Metric spike (renamed from cpa_spike — same math) ──────────────────────

const SPIKE_BASELINE_DAYS = 7;
const SPIKE_WARNING_RATIO = 1.5;
const SPIKE_CRITICAL_RATIO = 2.0;

/** 日次の 費用/成果 行（元実装: dd_ad_insights の spend/conversions） */
export interface CostOutcomeRow {
  date: string;
  spend: number | string | null;
  conversions: number | string | null;
}

export interface MetricSpikeOptions {
  metricType?: string;
  baselineDays?: number;
  warningRatio?: number;
  criticalRatio?: number;
  now?: () => Date;
}

/**
 * Detects unit-cost spikes (e.g. CPA) by comparing today's spend/conversion
 * ratio against the trailing baseline average. Returns `null` if the source
 * is missing or there is insufficient data to compare.
 */
export function createMetricSpikeDetector(
  fetchRows: FetchRows<CostOutcomeRow>,
  options: MetricSpikeOptions = {},
): Detector {
  const metricType = options.metricType ?? "metric_spike";
  const baselineDays = options.baselineDays ?? SPIKE_BASELINE_DAYS;
  const warningRatio = options.warningRatio ?? SPIKE_WARNING_RATIO;
  const criticalRatio = options.criticalRatio ?? SPIKE_CRITICAL_RATIO;
  const nowFn = options.now ?? (() => new Date());

  return async (tenantId: string): Promise<AnomalyResult | null> => {
    const today = nowFn();
    const todayStr = isoDay(today);
    const baselineStart = new Date(today);
    baselineStart.setDate(baselineStart.getDate() - baselineDays);
    const baselineStartStr = isoDay(baselineStart);

    let rows: CostOutcomeRow[];
    try {
      const data = await fetchRows(tenantId, { start: baselineStartStr, end: todayStr });
      if (data === null) return null;
      rows = data;
    } catch {
      return null;
    }

    if (rows.length === 0) return null;

    const today_rows = rows.filter((r) => r.date === todayStr);
    const baseline_rows = rows.filter((r) => r.date !== todayStr);
    if (today_rows.length === 0 || baseline_rows.length === 0) return null;

    const todaySpend = today_rows.reduce((s, r) => s + num(r.spend), 0);
    const todayConv = today_rows.reduce((s, r) => s + num(r.conversions), 0);
    if (todayConv <= 0) return null;
    const todayCpa = todaySpend / todayConv;

    const baseSpend = baseline_rows.reduce((s, r) => s + num(r.spend), 0);
    const baseConv = baseline_rows.reduce((s, r) => s + num(r.conversions), 0);
    if (baseConv <= 0) return null;
    const baselineCpa = baseSpend / baseConv;
    if (baselineCpa <= 0) return null;

    const ratio = todayCpa / baselineCpa;
    let severity: AnomalySeverity | null = null;
    let threshold = 0;
    if (ratio >= criticalRatio) {
      severity = "critical";
      threshold = baselineCpa * criticalRatio;
    } else if (ratio >= warningRatio) {
      severity = "warning";
      threshold = baselineCpa * warningRatio;
    }
    if (!severity) return null;

    return {
      metricType,
      severity,
      observedValue: Number(todayCpa.toFixed(4)),
      baselineValue: Number(baselineCpa.toFixed(4)),
      threshold: Number(threshold.toFixed(4)),
      details: {
        ratio: Number(ratio.toFixed(3)),
        baselineDays,
        todaySpend,
        todayConversions: todayConv,
      },
    };
  };
}

// ─── Delivery drop (renamed from email_delivery_drop — same math) ───────────

const DELIVERY_BASELINE_DAYS = 7;
const DELIVERY_WARNING_RATIO = 1.5;
const DELIVERY_CRITICAL_RATIO = 2.0;
const DELIVERY_MIN_VOLUME = 10; // skip detection if today < 10 sends (noise floor)
const DEFAULT_FAIL_STATUSES = ["bounced", "dropped", "spam"];

/** 配信イベント行（元実装: dd_email_deliveries の sent_at/status） */
export interface DeliveryRow {
  sent_at: string;
  status: string;
}

export interface DeliveryDropOptions {
  metricType?: string;
  baselineDays?: number;
  warningRatio?: number;
  criticalRatio?: number;
  /** 今日の送信数がこの値未満なら検出しない（noise floor。default: 10） */
  minVolume?: number;
  /** 失敗とみなす status 一覧（default: bounced/dropped/spam） */
  failStatuses?: string[];
  now?: () => Date;
}

/**
 * Delivery Drop detector.
 *
 * Compares today's failure rate (failStatuses / total) against the trailing
 * rolling average. Returns `null` when the source is missing, no data, or
 * today's volume is below the noise floor.
 */
export function createDeliveryDropDetector(
  fetchRows: FetchRows<DeliveryRow>,
  options: DeliveryDropOptions = {},
): Detector {
  const metricType = options.metricType ?? "delivery_drop";
  const baselineDays = options.baselineDays ?? DELIVERY_BASELINE_DAYS;
  const warningRatio = options.warningRatio ?? DELIVERY_WARNING_RATIO;
  const criticalRatio = options.criticalRatio ?? DELIVERY_CRITICAL_RATIO;
  const minVolume = options.minVolume ?? DELIVERY_MIN_VOLUME;
  const failStatuses = new Set(options.failStatuses ?? DEFAULT_FAIL_STATUSES);
  const nowFn = options.now ?? (() => new Date());

  return async (tenantId: string): Promise<AnomalyResult | null> => {
    const today = nowFn();
    const todayStart = new Date(today);
    todayStart.setUTCHours(0, 0, 0, 0);
    const baselineStart = new Date(todayStart);
    baselineStart.setDate(baselineStart.getDate() - baselineDays);

    let rows: DeliveryRow[];
    try {
      const data = await fetchRows(tenantId, {
        start: baselineStart.toISOString(),
        end: today.toISOString(),
      });
      if (data === null) return null;
      rows = data;
    } catch {
      return null;
    }

    if (rows.length === 0) return null;

    const todayRows = rows.filter((r) => new Date(r.sent_at) >= todayStart);
    const baselineRows = rows.filter((r) => new Date(r.sent_at) < todayStart);
    if (todayRows.length < minVolume || baselineRows.length === 0) return null;

    const todayFails = todayRows.filter((r) => failStatuses.has(r.status)).length;
    const todayRate = todayFails / todayRows.length;

    const baseFails = baselineRows.filter((r) => failStatuses.has(r.status)).length;
    const baselineRate = baseFails / baselineRows.length;
    if (baselineRate <= 0) return null;

    const ratio = todayRate / baselineRate;
    let severity: AnomalySeverity | null = null;
    let threshold = 0;
    if (ratio >= criticalRatio) {
      severity = "critical";
      threshold = baselineRate * criticalRatio;
    } else if (ratio >= warningRatio) {
      severity = "warning";
      threshold = baselineRate * warningRatio;
    }
    if (!severity) return null;

    return {
      metricType,
      severity,
      observedValue: Number(todayRate.toFixed(4)),
      baselineValue: Number(baselineRate.toFixed(4)),
      threshold: Number(threshold.toFixed(4)),
      details: {
        ratio: Number(ratio.toFixed(3)),
        baselineDays,
        todayVolume: todayRows.length,
        todayFailures: todayFails,
      },
    };
  };
}

// ─── Rank drop (renamed from seo_rank_drop — same math) ─────────────────────

const RANK_BASELINE_DAYS = 7;
const RANK_WARNING_DELTA = 5; // positions worse than baseline
const RANK_CRITICAL_DELTA = 10;

/** ランキング観測行（元実装: dd_seo_rankings の keyword/rank/captured_at） */
export interface RankRow {
  keyword: string;
  rank: number | string;
  captured_at: string;
}

export interface RankDropOptions {
  metricType?: string;
  baselineDays?: number;
  warningDelta?: number;
  criticalDelta?: number;
  now?: () => Date;
}

/**
 * Rank Drop detector.
 *
 * For each tracked keyword, compares today's average rank against the trailing
 * baseline. Higher numeric rank = worse position. Severity is the maximum
 * across all dropped keywords; `details.droppedKeywords` lists the top
 * offenders for the operator.
 */
export function createRankDropDetector(
  fetchRows: FetchRows<RankRow>,
  options: RankDropOptions = {},
): Detector {
  const metricType = options.metricType ?? "rank_drop";
  const baselineDays = options.baselineDays ?? RANK_BASELINE_DAYS;
  const warningDelta = options.warningDelta ?? RANK_WARNING_DELTA;
  const criticalDelta = options.criticalDelta ?? RANK_CRITICAL_DELTA;
  const nowFn = options.now ?? (() => new Date());

  return async (tenantId: string): Promise<AnomalyResult | null> => {
    const today = nowFn();
    const todayStart = new Date(today);
    todayStart.setUTCHours(0, 0, 0, 0);
    const baselineStart = new Date(todayStart);
    baselineStart.setDate(baselineStart.getDate() - baselineDays);

    let rows: RankRow[];
    try {
      const data = await fetchRows(tenantId, {
        start: baselineStart.toISOString(),
        end: today.toISOString(),
      });
      if (data === null) return null;
      rows = data;
    } catch {
      return null;
    }

    if (rows.length === 0) return null;

    // Bucket rows by keyword × (today vs baseline).
    const byKeyword = new Map<string, { today: number[]; baseline: number[] }>();
    for (const r of rows) {
      const rank = num(r.rank);
      if (rank <= 0) continue;
      const bucket = byKeyword.get(r.keyword) ?? { today: [], baseline: [] };
      if (new Date(r.captured_at) >= todayStart) bucket.today.push(rank);
      else bucket.baseline.push(rank);
      byKeyword.set(r.keyword, bucket);
    }

    interface Drop {
      keyword: string;
      todayRank: number;
      baselineRank: number;
      delta: number;
    }
    const drops: Drop[] = [];
    let maxDelta = 0;

    for (const [keyword, { today: todayRanks, baseline: baselineRanks }] of byKeyword) {
      if (todayRanks.length === 0 || baselineRanks.length === 0) continue;
      const todayRank = todayRanks.reduce((s, n) => s + n, 0) / todayRanks.length;
      const baselineRank = baselineRanks.reduce((s, n) => s + n, 0) / baselineRanks.length;
      const delta = todayRank - baselineRank;
      if (delta < warningDelta) continue;
      drops.push({ keyword, todayRank, baselineRank, delta });
      if (delta > maxDelta) maxDelta = delta;
    }

    if (drops.length === 0) return null;

    let severity: AnomalySeverity = "warning";
    let threshold = warningDelta;
    if (maxDelta >= criticalDelta) {
      severity = "critical";
      threshold = criticalDelta;
    }

    // Order worst-first so the operator sees the biggest offenders.
    drops.sort((a, b) => b.delta - a.delta);
    const top = drops.slice(0, 5);

    return {
      metricType,
      severity,
      observedValue: Number(maxDelta.toFixed(2)),
      threshold,
      details: {
        baselineDays,
        droppedKeywords: top.map((d) => ({
          keyword: d.keyword,
          todayRank: Number(d.todayRank.toFixed(2)),
          baselineRank: Number(d.baselineRank.toFixed(2)),
          delta: Number(d.delta.toFixed(2)),
        })),
        totalDroppedCount: drops.length,
      },
    };
  };
}
