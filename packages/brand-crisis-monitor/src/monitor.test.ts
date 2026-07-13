/**
 * Tests for runBrandCrisisMonitor (ported from 実運用SaaS brand-crisis-job.test.ts).
 *
 * Supabase / env / feature-flag / Slack fetch を注入式 store / resolveApiKey /
 * alerter / CrisisSource に置換。feature flag は「ソースを呼ぶ前に呼び出し側が
 * ゲートする」設計になったため、job 本体のフラグ分岐テストは削除。
 */
import { describe, it, expect, vi } from "vitest";

import { runBrandCrisisMonitor } from "./monitor";
import { InMemoryCrisisStore } from "./store";
import type {
  BrandCrisisConfig,
  CrisisMention,
  CrisisSource,
  GenerateJson,
  MonitoredKeyword,
} from "./types";

function stubSource(name: string, mentions: CrisisMention[]): CrisisSource {
  return { name, search: vi.fn().mockResolvedValue(mentions) };
}

function makeConfig(overrides: Partial<BrandCrisisConfig> & { store: InMemoryCrisisStore }): BrandCrisisConfig {
  return {
    sources: overrides.sources ?? [],
    store: overrides.store,
    generateJson:
      overrides.generateJson ??
      (vi.fn().mockResolvedValue({ sentiment: "neutral" }) as unknown as GenerateJson),
    resolveApiKey: overrides.resolveApiKey ?? (() => "test-key"),
    alerter: overrides.alerter,
    threshold: overrides.threshold,
    searchOptions: overrides.searchOptions,
    logger: overrides.logger,
  };
}

const KEYWORD: MonitoredKeyword = { id: "q1", tenant_id: "t1", keyword: "x" };

describe("runBrandCrisisMonitor", () => {
  it("returns early / inserts nothing when no keywords exist", async () => {
    const store = new InMemoryCrisisStore();
    await runBrandCrisisMonitor(makeConfig({ store }));
    expect(store._allMentions()).toHaveLength(0);
    expect(store._allAlerts()).toHaveLength(0);
  });

  it("does not insert mentions when sources return empty", async () => {
    const store = new InMemoryCrisisStore({ keywords: [KEYWORD] });
    await runBrandCrisisMonitor(makeConfig({ store, sources: [stubSource("reddit", [])] }));
    expect(store._allMentions()).toHaveLength(0);
  });

  it("classifies and inserts each mention", async () => {
    const store = new InMemoryCrisisStore({ keywords: [KEYWORD] });
    const source = stubSource("reddit", [
      { external_id: "reddit:1", content: "great product" },
      { external_id: "reddit:2", content: "terrible bug" },
    ]);
    const generateJson = vi.fn().mockResolvedValue({ sentiment: "negative" }) as unknown as GenerateJson;

    await runBrandCrisisMonitor(makeConfig({ store, sources: [source], generateJson }));

    const mentions = store._allMentions();
    expect(mentions).toHaveLength(2);
    expect(mentions[0]!.source).toBe("reddit");
    expect(mentions[0]!.sentiment).toBe("negative");
  });

  it("skips LLM (neutral) when no api key resolves", async () => {
    const store = new InMemoryCrisisStore({ keywords: [KEYWORD] });
    const source = stubSource("reddit", [{ external_id: "reddit:1", content: "hi" }]);
    const generateJson = vi.fn() as unknown as GenerateJson;

    await runBrandCrisisMonitor(makeConfig({ store, sources: [source], generateJson, resolveApiKey: () => "" }));

    expect(generateJson).not.toHaveBeenCalled();
    expect(store._allMentions()[0]!.sentiment).toBe("neutral");
  });

  it("does NOT alert when mention count is below threshold", async () => {
    const store = new InMemoryCrisisStore({ keywords: [KEYWORD] });
    store._seedRecentMentions("t1", 3); // below default 10
    await runBrandCrisisMonitor(makeConfig({ store, sources: [stubSource("reddit", [])] }));
    expect(store._allAlerts()).toHaveLength(0);
  });

  it("alerts when mention count exceeds threshold", async () => {
    const store = new InMemoryCrisisStore({ keywords: [KEYWORD] });
    store._seedRecentMentions("t1", 15); // above default 10
    const alerter = vi.fn();
    await runBrandCrisisMonitor(makeConfig({ store, sources: [stubSource("reddit", [])], alerter }));

    const alerts = store._allAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.alert_type).toBe("spike");
    expect(alerts[0]!.mention_count).toBe(15);
    expect(alerter).toHaveBeenCalledWith({ tenantId: "t1", alertType: "spike", count: 15, threshold: 10 });
  });

  it("respects a custom threshold", async () => {
    const store = new InMemoryCrisisStore({ keywords: [KEYWORD] });
    store._seedRecentMentions("t1", 4);
    await runBrandCrisisMonitor(makeConfig({ store, sources: [stubSource("reddit", [])], threshold: 3 }));
    expect(store._allAlerts()).toHaveLength(1);
  });

  it("swallows alerter errors without throwing", async () => {
    const store = new InMemoryCrisisStore({ keywords: [KEYWORD] });
    store._seedRecentMentions("t1", 15);
    const alerter = vi.fn().mockRejectedValue(new Error("network"));
    const logger = vi.fn();
    await expect(
      runBrandCrisisMonitor(makeConfig({ store, sources: [stubSource("reddit", [])], alerter, logger })),
    ).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith("error", expect.stringContaining("Failed to send alert"), expect.any(Error));
  });

  it("catches and logs store errors without throwing", async () => {
    const store = new InMemoryCrisisStore();
    vi.spyOn(store, "getMonitoredKeywords").mockRejectedValue(new Error("DB down"));
    const logger = vi.fn();
    await expect(runBrandCrisisMonitor(makeConfig({ store, logger }))).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith("error", expect.stringContaining("monitor failed"), expect.any(Error));
  });

  it("aggregates mentions from multiple sources", async () => {
    const store = new InMemoryCrisisStore({ keywords: [KEYWORD] });
    const reddit = stubSource("reddit", [{ external_id: "reddit:1", content: "a" }]);
    const news = stubSource("news", [{ external_id: "news:1", content: "b" }]);
    await runBrandCrisisMonitor(makeConfig({ store, sources: [reddit, news] }));
    const sources = store._allMentions().map((m) => m.source).sort();
    expect(sources).toEqual(["news", "reddit"]);
  });
});
