/**
 * Tests — ported from dev-dashboard-v2 tests/jobs/realtime-monitor.test.ts.
 * Supabase (teams / dd_anomaly_events) → listTenantIds / persistAnomaly 注入。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runRealtimeMonitor, type AnomalyAction, type MonitorLogger } from "./monitor";
import type { AnomalyResult, Detector } from "./detectors";

interface Harness {
  insertedRows: Array<{ tenantId: string; result: AnomalyResult; action: AnomalyAction | null }>;
  errors: unknown[];
  infos: string[];
  logger: MonitorLogger;
  persistAnomaly: (tenantId: string, result: AnomalyResult, action: AnomalyAction | null) => Promise<void>;
}

function buildHarness(): Harness {
  const insertedRows: Harness["insertedRows"] = [];
  const errors: unknown[] = [];
  const infos: string[] = [];
  return {
    insertedRows,
    errors,
    infos,
    logger: {
      error: (_ctx, err) => errors.push(err),
      info: (_ctx, message) => infos.push(message),
    },
    persistAnomaly: async (tenantId, result, action) => {
      insertedRows.push({ tenantId, result, action });
    },
  };
}

const SPIKE_RESULT: AnomalyResult = {
  metricType: "metric_spike",
  severity: "critical",
  observedValue: 120,
  baselineValue: 50,
  threshold: 100,
  details: { ratio: 2.4 },
};

describe("runRealtimeMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists an anomaly event and reports when a spike is detected", async () => {
    const h = buildHarness();
    const detectSpike: Detector = vi.fn(async () => SPIKE_RESULT);
    const detectNull: Detector = vi.fn(async () => null);

    const summary = await runRealtimeMonitor({
      listTenantIds: async () => ["tenant-A"],
      detectors: [detectSpike, detectNull, detectNull],
      persistAnomaly: h.persistAnomaly,
      logger: h.logger,
    });

    expect(summary).toEqual({ tenants: 1, anomalies: 1 });
    expect(h.insertedRows).toHaveLength(1);
    expect(h.insertedRows[0]).toMatchObject({
      tenantId: "tenant-A",
      action: null,
      result: {
        metricType: "metric_spike",
        severity: "critical",
        observedValue: 120,
        baselineValue: 50,
        threshold: 100,
      },
    });
    // Anomaly is reported via logger.error.
    const errorMessages = h.errors.map((e) => String(e));
    expect(errorMessages.some((m) => m.includes("metric_spike"))).toBe(true);
    expect(errorMessages.some((m) => m.includes("tenant=tenant-A"))).toBe(true);
  });

  it("persists nothing when every detector returns null", async () => {
    const h = buildHarness();
    const detectNull: Detector = vi.fn(async () => null);

    const summary = await runRealtimeMonitor({
      listTenantIds: async () => ["tenant-B"],
      detectors: [detectNull, detectNull, detectNull],
      persistAnomaly: h.persistAnomaly,
      logger: h.logger,
    });

    expect(summary).toEqual({ tenants: 1, anomalies: 0 });
    expect(h.insertedRows).toHaveLength(0);
    const errorMessages = h.errors.map((e) => String(e));
    expect(errorMessages.some((m) => m.includes("anomaly:"))).toBe(false);
    expect(h.infos.some((m) => m.includes("tenants=1 anomalies=0"))).toBe(true);
  });

  it("continues processing remaining tenants when one detector throws", async () => {
    const h = buildHarness();
    const detect: Detector = vi.fn(async (tenantId: string) => {
      if (tenantId === "tenant-fail") {
        throw new Error("simulated detector failure");
      }
      return {
        metricType: "metric_spike",
        severity: "warning" as const,
        observedValue: 80,
        baselineValue: 50,
        threshold: 75,
      };
    });

    const summary = await runRealtimeMonitor({
      listTenantIds: async () => ["tenant-fail", "tenant-ok"],
      detectors: [detect],
      persistAnomaly: h.persistAnomaly,
      logger: h.logger,
    });

    // The failing tenant's detector is logged but doesn't halt the run; the
    // healthy tenant still produced one persisted anomaly.
    expect(summary).toEqual({ tenants: 2, anomalies: 1 });
    expect(h.insertedRows).toHaveLength(1);
    expect(h.insertedRows[0]).toMatchObject({
      tenantId: "tenant-ok",
      result: { metricType: "metric_spike", severity: "warning" },
    });
    expect(h.errors.map((e) => String(e)).some((m) => m.includes("simulated detector failure"))).toBe(true);
  });

  it("stores the dispatched action alongside the anomaly", async () => {
    const h = buildHarness();
    const action: AnomalyAction = { actionType: "notify", channel: "#alerts" };

    await runRealtimeMonitor({
      listTenantIds: async () => ["tenant-A"],
      detectors: [async () => SPIKE_RESULT],
      persistAnomaly: h.persistAnomaly,
      dispatchAction: async () => action,
      logger: h.logger,
    });

    expect(h.insertedRows[0]?.action).toEqual(action);
  });

  it("persists with null action (and logs) when dispatchAction throws", async () => {
    const h = buildHarness();

    await runRealtimeMonitor({
      listTenantIds: async () => ["tenant-A"],
      detectors: [async () => SPIKE_RESULT],
      persistAnomaly: h.persistAnomaly,
      dispatchAction: async () => {
        throw new Error("dispatch boom");
      },
      logger: h.logger,
    });

    expect(h.insertedRows).toHaveLength(1);
    expect(h.insertedRows[0]?.action).toBeNull();
    expect(h.errors.map((e) => String(e)).some((m) => m.includes("dispatch boom"))).toBe(true);
  });

  it("logs and continues when persistAnomaly fails", async () => {
    const h = buildHarness();

    const summary = await runRealtimeMonitor({
      listTenantIds: async () => ["tenant-A"],
      detectors: [async () => SPIKE_RESULT],
      persistAnomaly: async () => {
        throw new Error("insert dd_anomaly_events failed");
      },
      logger: h.logger,
    });

    expect(summary).toEqual({ tenants: 1, anomalies: 1 });
    expect(h.errors.map((e) => String(e)).some((m) => m.includes("insert dd_anomaly_events failed"))).toBe(true);
  });

  it("returns zero summary and logs when tenant listing fails", async () => {
    const h = buildHarness();

    const summary = await runRealtimeMonitor({
      listTenantIds: async () => {
        throw new Error("failed to fetch tenants");
      },
      detectors: [async () => SPIKE_RESULT],
      persistAnomaly: h.persistAnomaly,
      logger: h.logger,
    });

    expect(summary).toEqual({ tenants: 0, anomalies: 0 });
    expect(h.insertedRows).toHaveLength(0);
    expect(h.errors.map((e) => String(e)).some((m) => m.includes("failed to fetch tenants"))).toBe(true);
  });

  it("falls back to console logging when no logger injected", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runRealtimeMonitor({
        listTenantIds: async () => ["tenant-C"],
        detectors: [async () => ({ ...SPIKE_RESULT, severity: "warning" as const })],
        persistAnomaly: async () => {},
      });
      expect(consoleErrorSpy).toHaveBeenCalled();
      const allErrorOutput = consoleErrorSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(allErrorOutput).toContain("metric_spike");
      expect(consoleLogSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });
});
