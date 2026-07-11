/**
 * Realtime monitoring orchestrator.
 *
 * Walks every tenant, runs each anomaly detector, persists detected anomalies
 * via the injected store, and dispatches an auto-healing action via the
 * injected dispatcher. Detected anomalies are also surfaced via
 * `logger.error` (元実装は Sentry 連携付き logError — 注入で差し替え可能)。
 *
 * 変更点（移植元: dev-dashboard-v2 server/jobs/realtime-monitor.ts）:
 * - Supabase（teams / dd_anomaly_events）→ `listTenantIds` / `persistAnomaly` 注入
 * - `dispatchAnomalyAction` → `dispatchAction` 注入（省略時は no-op = 通知なし）
 * - 固定 DETECTORS 配列 → `detectors: Detector[]` 注入（レジストリ）
 * - logger.ts → `logger` 注入（default: console.error / console.log）
 */
import type { AnomalyResult, Detector } from "./detectors";

const DEFAULT_CONTEXT = "realtime-monitor";

/** 自動対応アクション（元実装の AnomalyAction 相当の構造的最小型） */
export interface AnomalyAction {
  actionType: string;
  [key: string]: unknown;
}

export interface MonitorLogger {
  error(context: string, err: unknown): void;
  info(context: string, message: string): void;
}

export interface RealtimeMonitorOptions {
  /** 監視対象テナントIDの列挙（元実装: teams テーブル全走査） */
  listTenantIds(): Promise<string[]>;
  /** 実行する検出器のレジストリ */
  detectors: Detector[];
  /** 検出結果の永続化（元実装: dd_anomaly_events への insert） */
  persistAnomaly(
    tenantId: string,
    result: AnomalyResult,
    action: AnomalyAction | null,
  ): Promise<void>;
  /** 自動対応アクションの発火（元実装: dispatchAnomalyAction = Slack 通知）。省略時 null。 */
  dispatchAction?(tenantId: string, result: AnomalyResult): Promise<AnomalyAction | null>;
  logger?: MonitorLogger;
  /** ログ出力のコンテキスト名（default: "realtime-monitor"） */
  context?: string;
}

export interface MonitorSummary {
  tenants: number;
  anomalies: number;
}

const defaultLogger: MonitorLogger = {
  error: (context, err) => console.error(`[${context}]`, err),
  info: (context, message) => console.log(`[${context}] ${message}`),
};

export async function runRealtimeMonitor(options: RealtimeMonitorOptions): Promise<MonitorSummary> {
  const logger = options.logger ?? defaultLogger;
  const context = options.context ?? DEFAULT_CONTEXT;

  function reportAnomaly(tenantId: string, result: AnomalyResult): void {
    const summary =
      `anomaly: tenant=${tenantId} metric=${result.metricType} severity=${result.severity} ` +
      `observed=${result.observedValue} threshold=${result.threshold}`;
    // 元実装の logError は SENTRY_DSN 設定時に Sentry へ転送。ここでは注入 logger に委譲。
    logger.error(context, new Error(summary));
  }

  async function runForTenant(tenantId: string): Promise<number> {
    let detected = 0;
    for (const detect of options.detectors) {
      let result: AnomalyResult | null;
      try {
        result = await detect(tenantId);
      } catch (err) {
        logger.error(context, err);
        continue;
      }
      if (!result) continue;
      detected++;

      // Dispatch auto-healing action first so the result can be persisted
      // alongside the anomaly event for audit.
      let action: AnomalyAction | null = null;
      if (options.dispatchAction) {
        try {
          action = await options.dispatchAction(tenantId, result);
        } catch (err) {
          logger.error(context, err);
        }
      }

      try {
        await options.persistAnomaly(tenantId, result, action);
      } catch (err) {
        logger.error(context, err);
      }
      reportAnomaly(tenantId, result);
    }
    return detected;
  }

  let tenants: string[];
  try {
    tenants = await options.listTenantIds();
  } catch (err) {
    logger.error(context, err ?? new Error("failed to fetch tenants"));
    return { tenants: 0, anomalies: 0 };
  }

  let totalDetected = 0;
  for (const tenantId of tenants) {
    try {
      totalDetected += await runForTenant(tenantId);
    } catch (err) {
      // One tenant's failure must not halt the whole sweep.
      logger.error(context, err);
    }
  }

  logger.info(
    context,
    `realtime-monitor sweep complete: tenants=${tenants.length} anomalies=${totalDetected}`,
  );
  return { tenants: tenants.length, anomalies: totalDetected };
}
