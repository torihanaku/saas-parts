/**
 * Monitoring cycle: run injected anomaly detectors, persist events, auto-halt
 * offending actions, and notify.
 *
 * 出典: dev-dashboard-v2 server/lib/agent/monitor-service.ts
 * 変更点: CPA/メール/SEO の製品ディテクター → AnomalyDetector[] 注入 /
 *         dd_anomaly_events → AnomalyStore 注入 / Slack 通知 → notify 注入 /
 *         Supabase 直 update → PlanStore.updateAction で halt。
 */
import type { AuditLogger, PlanStore } from "./types";

export type AnomalySeverity = "info" | "warning" | "critical";

export interface AnomalyEvent {
  tenantId: string;
  /** e.g. "cpa_spike" | "email_delivery_drop" — free-form metric type. */
  type: string;
  severity: AnomalySeverity;
  metrics: Record<string, number>;
  /** "halt" cancels `targetActionId` automatically. */
  autoAction?: "halt" | "notify" | null;
  targetActionId?: string;
  details?: Record<string, unknown>;
  detectedAt: string;
}

export type AnomalyDetector = (tenantId: string) => Promise<AnomalyEvent[]>;

export interface AnomalyStore {
  record(event: AnomalyEvent): Promise<void>;
}

export interface MonitorConfig {
  detectors: AnomalyDetector[];
  /** Used to cancel actions on `autoAction: "halt"`. */
  store: PlanStore;
  anomalyStore?: AnomalyStore;
  audit?: AuditLogger;
  notify?: (event: AnomalyEvent) => Promise<void> | void;
  /** Detector/persist failures are isolated here (default: swallow). */
  onError?: (scope: string, error: Error) => void;
}

export interface Monitor {
  runMonitoringCycle(tenantId: string): Promise<AnomalyEvent[]>;
}

export function createMonitor(config: MonitorConfig): Monitor {
  const onError = config.onError ?? (() => {});

  async function haltAction(actionId: string, event: AnomalyEvent): Promise<void> {
    await config.store.updateAction(actionId, { status: "cancelled" });
    await config.audit?.({
      tenantId: event.tenantId,
      action: "agent_auto_halt",
      resourceType: "agent_action",
      resourceId: actionId,
      riskLevel: "critical",
      changes: {
        status: "cancelled",
        reason: "anomaly_detected",
        event_type: event.type,
        metrics: event.metrics,
      },
    });
  }

  return {
    async runMonitoringCycle(tenantId) {
      const events: AnomalyEvent[] = [];

      for (const detect of config.detectors) {
        try {
          events.push(...(await detect(tenantId)));
        } catch (err) {
          onError("agent.monitor", err instanceof Error ? err : new Error(String(err)));
        }
      }

      if (events.length === 0) return events;

      for (const ev of events) {
        try {
          await config.anomalyStore?.record(ev);
        } catch (err) {
          onError("agent.monitor.persist", err instanceof Error ? err : new Error(String(err)));
        }

        if (ev.autoAction === "halt" && ev.targetActionId) {
          await haltAction(ev.targetActionId, ev);
        }

        await config.notify?.(ev);
      }

      return events;
    },
  };
}
