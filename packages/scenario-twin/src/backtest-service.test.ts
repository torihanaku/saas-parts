/**
 * Tests for backtest-service.ts (ported from dev-dashboard-v2
 * tests/twin-backtest.test.ts). Store is injected as a fake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  recordBacktest,
  listBacktest,
  calculateAccuracy,
} from "./backtest-service.js";
import type { TwinStore, BacktestRecord, BacktestToStore } from "./store.js";

const insertBacktest = vi.fn();
const listBacktestFn = vi.fn();

const store = {
  insertBacktest,
  listBacktest: listBacktestFn,
} as unknown as TwinStore;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordBacktest", () => {
  it("computes error_percent and returns the new id", async () => {
    insertBacktest.mockResolvedValueOnce("bt1");
    const id = await recordBacktest(
      { tenantId: "t1", simulationId: "sim1", metric: "pv", predicted: 100, actual: 110 },
      store,
    );
    expect(id).toBe("bt1");
    const row = insertBacktest.mock.calls[0]![0] as BacktestToStore;
    expect(row.errorPercent).toBe(10); // (110-100)/100*100
    expect(row.metric).toBe("pv");
  });

  it("sets error_percent null when predicted is 0", async () => {
    insertBacktest.mockResolvedValueOnce("bt2");
    await recordBacktest(
      { tenantId: "t1", simulationId: "s", metric: "pv", predicted: 0, actual: 5 },
      store,
    );
    const row = insertBacktest.mock.calls[0]![0] as BacktestToStore;
    expect(row.errorPercent).toBeNull();
  });
});

describe("listBacktest", () => {
  it("delegates to the store", async () => {
    listBacktestFn.mockResolvedValueOnce([{ id: "bt1" }] as BacktestRecord[]);
    const records = await listBacktest("t1", store, 10);
    expect(records).toHaveLength(1);
    expect(listBacktestFn).toHaveBeenCalledWith("t1", 10);
  });
});

describe("calculateAccuracy", () => {
  it("computes MAPE / RMSE / MAE per metric", async () => {
    listBacktestFn.mockResolvedValueOnce([
      { metric: "pv", predicted: 100, actual: 110 },
      { metric: "pv", predicted: 200, actual: 180 },
      { metric: "cv", predicted: 10, actual: 10 },
    ] as BacktestRecord[]);

    const accuracy = await calculateAccuracy("t1", store);
    expect(accuracy).toHaveLength(2);

    const pv = accuracy.find((a) => a.metric === "pv")!;
    expect(pv.mape).toBeCloseTo(10);
    expect(pv.rmse).toBeCloseTo(15.811, 2);
    expect(pv.mae).toBeCloseTo(15);
    expect(pv.count).toBe(2);

    const cv = accuracy.find((a) => a.metric === "cv")!;
    expect(cv.mape).toBe(0);
    expect(cv.rmse).toBe(0);
  });

  it("returns [] for no records", async () => {
    listBacktestFn.mockResolvedValueOnce([]);
    expect(await calculateAccuracy("t1", store)).toEqual([]);
  });
});
