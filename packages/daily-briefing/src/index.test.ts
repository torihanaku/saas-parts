import { describe, it, expect, vi } from "vitest";
import {
  makeFetchGa4,
  makeFetchCosts,
  makeFetchCampaigns,
  makeFetchSns,
  createDefaultWidgetDataRegistry,
  WidgetDataRegistry,
  generateBriefingContent,
  formatActivityMetrics,
  getYesterdayDate,
  composeDailyBriefing,
  composeShot,
  ComposeError,
  type TableQuery,
  type ComposeInput,
} from "./index";

const params = { dateRange: "7d", limit: 10 } as const;

// ── sources (ported from dev-dashboard-v2 widget-data-sources.test.ts) ──
describe("makeFetchGa4", () => {
  it("flattens metrics_cache from connected GA integration", async () => {
    const q: TableQuery = async () => [
      { metrics_cache: { sessions: 1234, pageviews: 4567 }, last_synced: "x" },
    ];
    const res = await makeFetchGa4(q)(params, "t1");
    expect(res.data).toEqual([
      { metric: "sessions", value: 1234 },
      { metric: "pageviews", value: 4567 },
    ]);
  });

  it("returns empty data when no integration (never placeholder)", async () => {
    const res = await makeFetchGa4(async () => [])(params, "t1");
    expect(res.data).toEqual([]);
  });
});

describe("makeFetchCosts", () => {
  it("aggregates spend per day sorted ascending", async () => {
    const q: TableQuery = async () => [
      { date: "2026-05-01", platform: "google", spend: 100 },
      { date: "2026-05-01", platform: "meta", spend: 50 },
      { date: "2026-05-02", platform: "google", spend: 200 },
    ];
    const res = await makeFetchCosts(q)(params, "t1");
    expect(res.data).toEqual([
      { date: "2026-05-01", spend: 150 },
      { date: "2026-05-02", spend: 200 },
    ]);
  });

  it("returns empty on no rows", async () => {
    expect((await makeFetchCosts(async () => null)(params, "t1")).data).toEqual([]);
  });
});

describe("makeFetchCampaigns", () => {
  it("aggregates per (platform, campaign_id) and computes ROAS", async () => {
    const q: TableQuery = async () => [
      { campaign_id: "c1", platform: "google", spend: 100, conversions: 5, revenue: 500 },
      { campaign_id: "c1", platform: "google", spend: 50, conversions: 2, revenue: 200 },
      { campaign_id: "c2", platform: "meta", spend: 80, conversions: 1, revenue: 0 },
    ];
    const res = await makeFetchCampaigns(q)(params, "t1");
    const rows = res.data as Array<{ campaign_id: string; roas: number }>;
    expect(rows.find((r) => r.campaign_id === "c1")).toMatchObject({
      spend: 150,
      conversions: 7,
      revenue: 700,
      roas: 4.67,
    });
    expect(rows.find((r) => r.campaign_id === "c2")!.roas).toBe(0);
  });
});

describe("makeFetchSns", () => {
  it("counts published posts per platform", async () => {
    const q: TableQuery = async () => [
      { status: "published", platforms: ["twitter", "linkedin"], published_at: "x" },
      { status: "published", platforms: ["twitter"], published_at: "y" },
      { status: "published", platforms: [], published_at: "z" },
    ];
    const res = await makeFetchSns(q)(params, "t1");
    const map = Object.fromEntries(
      (res.data as { platform: string; count: number }[]).map((r) => [r.platform, r.count]),
    );
    expect(map.twitter).toBe(2);
    expect(map.linkedin).toBe(1);
    expect(map.unknown).toBe(1);
  });
});

// Regression: tenant scoping. Without tenantColumns configured, the fetchers
// dropped tenantId → every tenant's briefing read ALL tenants' widget data
// (cross-tenant leak). tenantColumns must inject a PostgREST tenant filter.
describe("tenant scoping (cross-tenant leak guard)", () => {
  function captureQuery() {
    let last = "";
    const q: TableQuery = async (_table, query) => {
      last = query;
      return [];
    };
    return { q, get: () => last };
  }

  it("does NOT scope by default (single-tenant, matches original)", async () => {
    const cap = captureQuery();
    await makeFetchCosts(cap.q)(params, "tenant-A");
    expect(cap.get()).not.toContain("=eq.tenant-A");
  });

  it("scopes ga4/costs/campaigns/sns when tenantColumns set", async () => {
    const tables = {
      integrations: "dashboard_integrations",
      adInsights: "dd_ad_insights",
      contentCalendar: "dd_content_calendar",
      tenantColumns: {
        integrations: "tenant_id",
        adInsights: "tenant_id",
        contentCalendar: "project_id",
      },
    };
    for (const [mk, col] of [
      [makeFetchGa4, "tenant_id"],
      [makeFetchCosts, "tenant_id"],
      [makeFetchCampaigns, "tenant_id"],
      [makeFetchSns, "project_id"],
    ] as const) {
      const cap = captureQuery();
      await mk(cap.q, tables)(params, "tenant-A");
      expect(cap.get()).toContain(`${col}=eq.tenant-A`);
    }
  });

  it("URL-encodes the tenant id in the filter", async () => {
    const tables = {
      integrations: "dashboard_integrations",
      adInsights: "dd_ad_insights",
      contentCalendar: "dd_content_calendar",
      tenantColumns: { adInsights: "tenant_id" },
    };
    const cap = captureQuery();
    await makeFetchCosts(cap.q, tables)(params, "a b/c");
    expect(cap.get()).toContain("tenant_id=eq.a%20b%2Fc");
  });
});

describe("WidgetDataRegistry", () => {
  it("registers defaults and resolves by name", async () => {
    const reg = createDefaultWidgetDataRegistry(async () => []);
    expect(reg.list().sort()).toEqual(["campaigns", "costs", "ga4", "sns"]);
    expect(reg.has("ga4")).toBe(true);
  });

  it("returns empty response for unknown dataSource", async () => {
    const reg = new WidgetDataRegistry();
    const res = await reg.fetch("nope", params, "t1");
    expect(res.data).toEqual([]);
  });
});

// ── briefing ──
describe("generateBriefingContent", () => {
  it("collects metrics, builds prompt, returns LLM text", async () => {
    const generateText = vi.fn(
      async (_apiKey: string, _system: string, _user: string) => "morning briefing",
    );
    const content = await generateBriefingContent({
      date: "2026-05-10",
      apiKey: "k",
      collectors: [
        async () => ({ label: "レポート生成", count: 3 }),
        async () => ({ label: "下書き", count: 5, detail: { label: "公開済み", count: 2 } }),
      ],
      generateText,
    });
    expect(content).toBe("morning briefing");
    const userPrompt = generateText.mock.calls[0]![2];
    expect(userPrompt).toContain("2026-05-10");
    expect(userPrompt).toContain("レポート生成: 3件");
    expect(userPrompt).toContain("公開済み: 2件");
  });

  it("survives a failing collector (allSettled)", async () => {
    const content = await generateBriefingContent({
      date: "2026-05-10",
      apiKey: "k",
      collectors: [
        async () => ({ label: "OK", count: 1 }),
        async () => {
          throw new Error("db down");
        },
      ],
      generateText: async () => "ok",
    });
    expect(content).toBe("ok");
  });

  it("falls back when LLM returns empty", async () => {
    const content = await generateBriefingContent({
      date: "2026-05-10",
      apiKey: "k",
      collectors: [],
      generateText: async () => "",
    });
    expect(content).toBe("ブリーフィングを生成できませんでした");
  });
});

describe("formatActivityMetrics / getYesterdayDate", () => {
  it("formats bullet lines", () => {
    expect(formatActivityMetrics([{ label: "A", count: 2 }])).toBe("- A: 2件");
  });
  it("yesterday is one day before", () => {
    expect(getYesterdayDate(new Date("2026-05-10T00:00:00Z"))).toBe("2026-05-09");
  });
});

// ── compose ──
const composeDeps = {
  compose: vi.fn(),
  getUserContext: async () => "ctx",
  newId: () => "id-1",
  dateKey: () => "2026-05-10",
  now: () => "2026-05-10T09:00:00Z",
};

describe("composeDailyBriefing", () => {
  it("builds a DashboardSpec from compose output", async () => {
    const deps = {
      ...composeDeps,
      compose: vi.fn(async () => ({
        widgets: [{ id: "w1", type: "scorecard", title: "T", params: {} }],
        inputTokens: 100,
        outputTokens: 50,
      })),
    };
    const spec = await composeDailyBriefing("k", deps);
    expect(spec).toMatchObject({
      id: "id-1",
      kind: "daily",
      dateKey: "2026-05-10",
      tokensUsed: 150,
    });
    expect(spec.widgets).toHaveLength(1);
  });

  it("throws compose_returned_no_widgets on empty", async () => {
    const deps = {
      ...composeDeps,
      compose: vi.fn(async () => ({ widgets: [], inputTokens: 0, outputTokens: 0 })),
    };
    await expect(composeDailyBriefing("k", deps)).rejects.toBeInstanceOf(ComposeError);
    await expect(composeDailyBriefing("k", deps)).rejects.toMatchObject({
      code: "compose_returned_no_widgets",
    });
  });

  it("wraps compose exception as compose_failed", async () => {
    const deps = {
      ...composeDeps,
      compose: vi.fn(async () => {
        throw new Error("502");
      }),
    };
    await expect(composeDailyBriefing("k", deps)).rejects.toMatchObject({
      code: "compose_failed",
    });
  });
});

describe("composeShot", () => {
  it("passes question + context and returns shot spec", async () => {
    const compose = vi.fn(async (_input: ComposeInput) => ({
      widgets: [{ id: "s1", type: "table", title: "Q", params: {} }],
      inputTokens: 10,
      outputTokens: 20,
    }));
    const spec = await composeShot("k", "why down?", { ...composeDeps, compose }, [
      { id: "ctx", type: "line_chart", title: "C", params: {} },
    ]);
    expect(spec.kind).toBe("shot");
    expect(spec.tokensUsed).toBe(30);
    expect(compose.mock.calls[0]![0]).toMatchObject({
      kind: "shot",
      question: "why down?",
    });
  });
});
