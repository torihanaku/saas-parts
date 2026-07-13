/**
 * Ported from 実運用SaaS tests/daily-dashboard-store.test.ts (#721).
 * Supabase (supabaseGet / fetch) モックを WidgetStoreDriver モック注入に置換。
 * 末尾にインメモリドライバの統合テストを追加。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  todayDateKey,
  cryptoRandomUuid,
  createWidgetStore,
  createInMemoryWidgetStoreDriver,
  type WidgetStoreDriver,
  type WidgetSpec,
  type DashboardSpec,
  type DashboardRow,
} from "./index";

const WIDGET: WidgetSpec = {
  id: "w-1",
  type: "scorecard",
  title: "Sessions",
  params: { dataSource: "ga4", dateRange: "7d" },
  size: "sm",
  reason: "test",
};

const SPEC: DashboardSpec = {
  id: "d-1",
  kind: "shot",
  dateKey: "2026-04-18",
  generatedAt: "2026-04-18T00:00:00Z",
  widgets: [WIDGET],
};

function rowOf(spec: DashboardSpec, overrides: Partial<DashboardRow> = {}): DashboardRow {
  return {
    id: spec.id,
    tenantId: "t1",
    userId: "u1",
    kind: spec.kind,
    dateKey: spec.dateKey,
    specJson: spec,
    tokensUsed: spec.tokensUsed ?? 0,
    createdAt: "2026-04-18T00:00:00Z",
    updatedAt: "2026-04-18T00:00:00Z",
    ...overrides,
  };
}

function createMockDriver() {
  return {
    findDashboards: vi.fn<WidgetStoreDriver["findDashboards"]>(),
    insertDashboard: vi.fn<WidgetStoreDriver["insertDashboard"]>(),
    upsertDashboard: vi.fn<WidgetStoreDriver["upsertDashboard"]>(),
    listSignals: vi.fn<WidgetStoreDriver["listSignals"]>(),
    findFavorites: vi.fn<WidgetStoreDriver["findFavorites"]>(),
    upsertFavorite: vi.fn<WidgetStoreDriver["upsertFavorite"]>(),
    deleteFavorite: vi.fn<WidgetStoreDriver["deleteFavorite"]>(),
  } satisfies WidgetStoreDriver;
}

let driver = createMockDriver();
let store = createWidgetStore({ driver, logger: () => {} });

beforeEach(() => {
  driver = createMockDriver();
  store = createWidgetStore({ driver, logger: () => {} });
});

describe("todayDateKey / cryptoRandomUuid", () => {
  it("todayDateKey returns YYYY-MM-DD", () => {
    expect(todayDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("cryptoRandomUuid returns a non-empty string", () => {
    const id = cryptoRandomUuid();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});

describe("fetchTodayCache", () => {
  it("returns the cached spec when one exists", async () => {
    driver.findDashboards.mockResolvedValueOnce([rowOf(SPEC)]);
    const spec = await store.fetchTodayCache("t1", "u1");
    expect(spec?.id).toBe("d-1");
    expect(driver.findDashboards).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "daily", dateKey: todayDateKey(), limit: 1 }),
    );
  });

  it("returns null on thrown errors", async () => {
    driver.findDashboards.mockRejectedValueOnce(new Error("boom"));
    expect(await store.fetchTodayCache("t1", "u1")).toBeNull();
  });

  it("returns null when row is missing", async () => {
    driver.findDashboards.mockResolvedValueOnce([]);
    expect(await store.fetchTodayCache("t1", "u1")).toBeNull();
  });
});

describe("fetchSignalSummary", () => {
  it("formats signal rows into a text summary", async () => {
    driver.listSignals.mockResolvedValueOnce([
      { signalType: "alert", description: "Traffic spike", value: "+200%", observedAt: null },
    ]);
    const text = await store.fetchSignalSummary();
    expect(text).toContain("alert");
    expect(text).toContain("+200%");
  });

  it("returns empty-state message when no rows", async () => {
    driver.listSignals.mockResolvedValueOnce([]);
    expect(await store.fetchSignalSummary()).toContain("notable signal なし");
  });

  it("returns fallback on error", async () => {
    driver.listSignals.mockRejectedValueOnce(new Error("db"));
    expect(await store.fetchSignalSummary()).toContain("失敗");
  });
});

describe("fetchFavorites", () => {
  it("maps rows to WidgetSpec[] (limit 4)", async () => {
    driver.findFavorites.mockResolvedValueOnce([
      {
        id: "fav-1",
        tenantId: "t1",
        userId: "u1",
        sourceWidgetId: "w-1",
        widgetSpec: WIDGET,
        pinnedPosition: null,
        createdAt: "2026-04-18T00:00:00Z",
      },
    ]);
    const list = await store.fetchFavorites("t1", "u1");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("w-1");
    expect(driver.findFavorites).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 4 }),
    );
  });

  it("returns [] on error", async () => {
    driver.findFavorites.mockRejectedValueOnce(new Error("db"));
    expect(await store.fetchFavorites("t1", "u1")).toEqual([]);
  });
});

describe("fetchContextDashboard / fetchShotById / fetchStockById", () => {
  it("fetchContextDashboard returns spec when a row exists", async () => {
    driver.findDashboards.mockResolvedValueOnce([rowOf(SPEC)]);
    expect((await store.fetchContextDashboard("t1", "u1", "daily"))?.id).toBe("d-1");
  });

  it("fetchShotById returns null when not found", async () => {
    driver.findDashboards.mockResolvedValueOnce([]);
    expect(await store.fetchShotById("t1", "u1", "x")).toBeNull();
  });

  it("fetchStockById returns spec when found", async () => {
    const stockSpec: DashboardSpec = { ...SPEC, kind: "stock" };
    driver.findDashboards.mockResolvedValueOnce([rowOf(stockSpec)]);
    const spec = await store.fetchStockById("t1", "u1", "stock-1");
    expect(spec?.kind).toBe("stock");
  });

  it("fetchContextDashboard returns null on error", async () => {
    driver.findDashboards.mockRejectedValueOnce(new Error("db"));
    expect(await store.fetchContextDashboard("t1", "u1", "daily")).toBeNull();
  });
});

describe("persistShot / persistStock / persistDashboard", () => {
  it("persistShot inserts with dateKey=null and enriched spec", async () => {
    driver.insertDashboard.mockResolvedValueOnce(undefined);
    await store.persistShot("t1", "u1", SPEC, { question: "why?" });
    expect(driver.insertDashboard).toHaveBeenCalledOnce();
    const row = driver.insertDashboard.mock.calls[0]?.[0];
    expect(row?.dateKey).toBeNull();
    expect(row?.specJson.question).toBe("why?");
  });

  it("persistStock inserts with dateKey=null", async () => {
    driver.insertDashboard.mockResolvedValueOnce(undefined);
    await store.persistStock("t1", "u1", { ...SPEC, kind: "stock" });
    expect(driver.insertDashboard).toHaveBeenCalledOnce();
    const row = driver.insertDashboard.mock.calls[0]?.[0];
    expect(row?.kind).toBe("stock");
    expect(row?.dateKey).toBeNull();
  });

  it("persistDashboard uses the upsert path with spec.dateKey", async () => {
    driver.upsertDashboard.mockResolvedValueOnce(undefined);
    await store.persistDashboard("t1", "u1", { ...SPEC, kind: "daily" });
    expect(driver.upsertDashboard).toHaveBeenCalledOnce();
    const row = driver.upsertDashboard.mock.calls[0]?.[0];
    expect(row?.dateKey).toBe("2026-04-18");
  });

  it("persistStock swallows errors", async () => {
    driver.insertDashboard.mockRejectedValueOnce(new Error("net"));
    await expect(store.persistStock("t1", "u1", SPEC)).resolves.toBeUndefined();
  });
});

describe("listStocks", () => {
  it("maps rows to StockListItem[]", async () => {
    driver.findDashboards.mockResolvedValueOnce([
      rowOf({ ...SPEC, id: "s1", kind: "stock", question: "Q1" }, { id: "s1" }),
      rowOf({ ...SPEC, id: "s2-abcdef00", kind: "stock" }, { id: "s2-abcdef00" }),
    ]);
    const items = await store.listStocks("t1", "u1");
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("Q1");
    expect(items[1]?.title).toMatch(/^Stock /);
  });

  it("returns [] on error", async () => {
    driver.findDashboards.mockRejectedValueOnce(new Error("db"));
    expect(await store.listStocks("t1", "u1")).toEqual([]);
  });
});

describe("addFavorite / deleteFavorite / listFavoriteItems", () => {
  it("addFavorite returns normalized FavoriteItem on success", async () => {
    driver.upsertFavorite.mockResolvedValueOnce({
      id: "fav-1",
      tenantId: "t1",
      userId: "u1",
      sourceWidgetId: "w-1",
      widgetSpec: WIDGET,
      pinnedPosition: null,
      createdAt: "2026-04-18T00:00:00Z",
    });
    const item = await store.addFavorite("t1", "u1", { sourceWidgetId: "w-1", widgetSpec: WIDGET });
    expect(item?.id).toBe("fav-1");
    expect(item?.sourceWidgetId).toBe("w-1");
  });

  it("addFavorite returns null when driver returns null", async () => {
    driver.upsertFavorite.mockResolvedValueOnce(null);
    expect(await store.addFavorite("t1", "u1", { sourceWidgetId: "w-1", widgetSpec: WIDGET })).toBeNull();
  });

  it("addFavorite returns null on thrown errors", async () => {
    driver.upsertFavorite.mockRejectedValueOnce(new Error("net"));
    expect(await store.addFavorite("t1", "u1", { sourceWidgetId: "w-1", widgetSpec: WIDGET })).toBeNull();
  });

  it("deleteFavorite returns true on success", async () => {
    driver.deleteFavorite.mockResolvedValueOnce(true);
    expect(await store.deleteFavorite("t1", "u1", "fav-1")).toBe(true);
  });

  it("deleteFavorite returns false when not found", async () => {
    driver.deleteFavorite.mockResolvedValueOnce(false);
    expect(await store.deleteFavorite("t1", "u1", "fav-x")).toBe(false);
  });

  it("deleteFavorite returns false on thrown error", async () => {
    driver.deleteFavorite.mockRejectedValueOnce(new Error("net"));
    expect(await store.deleteFavorite("t1", "u1", "fav-x")).toBe(false);
  });

  it("listFavoriteItems maps rows to FavoriteItem[]", async () => {
    driver.findFavorites.mockResolvedValueOnce([
      {
        id: "fav-1",
        tenantId: "t1",
        userId: "u1",
        sourceWidgetId: "w-1",
        widgetSpec: WIDGET,
        pinnedPosition: 0,
        createdAt: "2026-04-18T00:00:00Z",
      },
    ]);
    const items = await store.listFavoriteItems("t1", "u1");
    expect(items).toHaveLength(1);
    expect(items[0]?.pinnedPosition).toBe(0);
  });

  it("listFavoriteItems returns [] on error", async () => {
    driver.findFavorites.mockRejectedValueOnce(new Error("db"));
    expect(await store.listFavoriteItems("t1", "u1")).toEqual([]);
  });
});

// ─── インメモリドライバ統合テスト ────────────────────────────────────────

describe("createInMemoryWidgetStoreDriver (integration)", () => {
  it("persistDashboard upserts daily by (tenant, user, dateKey) and fetchTodayCache reads it back", async () => {
    const s = createWidgetStore();
    const daily: DashboardSpec = { ...SPEC, kind: "daily", dateKey: todayDateKey() };
    await s.persistDashboard("t1", "u1", daily);
    await s.persistDashboard("t1", "u1", { ...daily, tokensUsed: 42 });
    const cached = await s.fetchTodayCache("t1", "u1");
    expect(cached?.tokensUsed).toBe(42);
    // 別テナントには見えない
    expect(await s.fetchTodayCache("t2", "u1")).toBeNull();
  });

  it("shot → stock → list/get roundtrip", async () => {
    const s = createWidgetStore();
    await s.persistShot("t1", "u1", SPEC, { question: "why?" });
    const shot = await s.fetchShotById("t1", "u1", "d-1");
    expect(shot?.question).toBe("why?");

    await s.persistStock("t1", "u1", { ...SPEC, id: "d-2", kind: "stock", question: "Q" });
    const stocks = await s.listStocks("t1", "u1");
    expect(stocks).toHaveLength(1);
    expect(stocks[0]?.title).toBe("Q");
    expect((await s.fetchStockById("t1", "u1", "d-2"))?.kind).toBe("stock");
  });

  it("favorite upsert merges duplicates and honours pinned ordering", async () => {
    const s = createWidgetStore();
    const first = await s.addFavorite("t1", "u1", { sourceWidgetId: "w-1", widgetSpec: WIDGET });
    const dup = await s.addFavorite("t1", "u1", {
      sourceWidgetId: "w-1",
      widgetSpec: { ...WIDGET, title: "Updated" },
      pinnedPosition: 1,
    });
    expect(dup?.id).toBe(first?.id);

    await s.addFavorite("t1", "u1", {
      sourceWidgetId: "w-2",
      widgetSpec: { ...WIDGET, id: "w-2" },
      pinnedPosition: 0,
    });

    const items = await s.listFavoriteItems("t1", "u1");
    expect(items).toHaveLength(2);
    expect(items[0]?.sourceWidgetId).toBe("w-2"); // pinnedPosition 0 が先頭
    expect(items[1]?.widgetSpec.title).toBe("Updated");

    expect(await s.deleteFavorite("t1", "u1", items[0]?.id ?? "")).toBe(true);
    expect(await s.deleteFavorite("t1", "u1", "missing")).toBe(false);
  });

  it("signal summary reflects injected signals", async () => {
    const d = createInMemoryWidgetStoreDriver({
      signals: [{ signalType: "alert", description: "spike", value: "+10%", observedAt: null }],
    });
    const s = createWidgetStore({ driver: d });
    expect(await s.fetchSignalSummary()).toContain("spike");
    d.setSignals([]);
    expect(await s.fetchSignalSummary()).toContain("notable signal なし");
  });
});
