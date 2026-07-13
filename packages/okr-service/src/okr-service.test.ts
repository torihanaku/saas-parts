/**
 * Ported from dev-dashboard-v2 `tests/okr-service.test.ts` — adapted from
 * supabase mocks to the injected InMemoryOkrStore / InMemoryOkrMetricsStore.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  OkrService,
  InMemoryOkrStore,
  InMemoryOkrMetricsStore,
  createDefaultAutoSourceProviders,
  calculateProgress,
} from "./okr-service";

let store: InMemoryOkrStore;
let metrics: InMemoryOkrMetricsStore;
let service: OkrService;

beforeEach(() => {
  store = new InMemoryOkrStore();
  metrics = new InMemoryOkrMetricsStore();
  service = new OkrService({
    store,
    providers: createDefaultAutoSourceProviders(metrics),
  });
});

function seedObjective(id: string, overrides: Partial<Parameters<InMemoryOkrStore["insertObjective"]>[0]> = {}) {
  store.objectives.push({
    id,
    project_id: "proj-1",
    title: `Objective ${id}`,
    quarter: "2026-Q2",
    progress: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function seedKeyResult(id: string, objectiveId: string, overrides: Partial<Parameters<InMemoryOkrStore["insertKeyResult"]>[0]> = {}) {
  store.keyResults.push({
    id,
    objective_id: objectiveId,
    title: `KR ${id}`,
    target: 100,
    current: 0,
    unit: "items",
    auto_source: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("getObjectives", () => {
  it("returns objectives with key results", async () => {
    seedObjective("obj-1", { title: "Grow traffic", progress: 40 });
    seedKeyResult("kr-1", "obj-1", { title: "Monthly sessions", target: 10000, current: 4000, unit: "sessions" });

    const objectives = await service.getObjectives("proj-1", "2026-Q2");
    expect(objectives).toHaveLength(1);
    expect(objectives[0]!.title).toBe("Grow traffic");
    expect(objectives[0]!.key_results).toHaveLength(1);
    expect(objectives[0]!.key_results[0]!.auto_source).toBeUndefined();
  });

  it("filters by quarter", async () => {
    seedObjective("obj-1", { quarter: "2026-Q1" });
    seedObjective("obj-2", { quarter: "2026-Q2" });
    const objectives = await service.getObjectives("proj-1", "2026-Q2");
    expect(objectives).toHaveLength(1);
    expect(objectives[0]!.id).toBe("obj-2");
  });

  it("returns empty array when no objectives", async () => {
    const objectives = await service.getObjectives("proj-1");
    expect(objectives).toEqual([]);
  });
});

describe("upsertObjective", () => {
  it("inserts new objective", async () => {
    const result = await service.upsertObjective({ project_id: "proj-1", title: "New OKR", quarter: "2026-Q2", progress: 0 });
    expect(result).toBe(true);
    expect(store.objectives).toHaveLength(1);
    expect(store.objectives[0]!.title).toBe("New OKR");
  });

  it("updates existing objective", async () => {
    seedObjective("obj-1");
    const result = await service.upsertObjective({ id: "obj-1", project_id: "proj-1", title: "Updated", quarter: "2026-Q2", progress: 10 });
    expect(result).toBe(true);
    expect(store.objectives[0]!.title).toBe("Updated");
    expect(store.objectives[0]!.progress).toBe(10);
  });
});

describe("upsertKeyResult", () => {
  it("inserts new key result", async () => {
    const result = await service.upsertKeyResult({ objective_id: "obj-1", title: "Sessions", target: 10000, current: 0, unit: "sessions" });
    expect(result).toBe(true);
    expect(store.keyResults).toHaveLength(1);
    expect(store.keyResults[0]!.auto_source).toBeNull();
  });
});

describe("deleteObjective", () => {
  it("deletes the objective and its key results", async () => {
    seedObjective("obj-1");
    seedKeyResult("kr-1", "obj-1");
    seedKeyResult("kr-2", "obj-1");
    const ok = await service.deleteObjective("obj-1");
    expect(ok).toBe(true);
    expect(store.objectives).toHaveLength(0);
    expect(store.keyResults).toHaveLength(0);
  });
});

describe("calculateProgress", () => {
  it("returns 0 for empty key results", () => {
    expect(calculateProgress([])).toBe(0);
  });

  it("caps each KR at 100%", () => {
    expect(calculateProgress([
      { objective_id: "o", title: "a", target: 100, current: 300, unit: "x" },
      { objective_id: "o", title: "b", target: 100, current: 0, unit: "x" },
    ])).toBe(50);
  });

  it("treats target<=0 as 0%", () => {
    expect(calculateProgress([
      { objective_id: "o", title: "a", target: 0, current: 10, unit: "x" },
    ])).toBe(0);
  });

  it("floors a below-baseline (negative current) KR at 0% (no negative progress)", () => {
    // Regression: a regressed metric must not push objective progress negative.
    expect(calculateProgress([
      { objective_id: "o", title: "a", target: 100, current: -50, unit: "x" },
    ])).toBe(0);
    expect(calculateProgress([
      { objective_id: "o", title: "a", target: 100, current: 200, unit: "x" },
      { objective_id: "o", title: "b", target: 100, current: -100, unit: "x" },
    ])).toBe(50); // (100 + 0) / 2, not (100 + -100)/2 = 0
  });
});

describe("autoUpdateProgress", () => {
  it("returns zero when no objectives", async () => {
    const result = await service.autoUpdateProgress("proj-1");
    expect(result).toBe(0);
  });

  it("skips KRs without auto_source", async () => {
    seedObjective("obj-1");
    seedKeyResult("kr-1", "obj-1");
    const result = await service.autoUpdateProgress("proj-1");
    expect(result).toBe(0);
  });

  it("resolves ga4:sessions auto_source (sum of latest snapshots)", async () => {
    seedObjective("obj-1", { title: "Traffic" });
    seedKeyResult("kr-1", "obj-1", { title: "Sessions", target: 10000, current: 0, unit: "sessions", auto_source: "ga4:sessions" });
    metrics.analyticsSnapshots.push(
      { project_id: "proj-1", metric_type: "sessions", value: 500, period_start: "2026-03-01" },
      { project_id: "proj-1", metric_type: "sessions", value: 800, period_start: "2026-04-01" },
      { project_id: "proj-1", metric_type: "sessions", value: 700, period_start: "2026-05-01" },
    );

    const result = await service.autoUpdateProgress("proj-1");
    expect(result).toBe(1);
    expect(store.keyResults[0]!.current).toBe(2000);
    // Objective progress recalculated: 2000/10000 = 20%
    expect(store.objectives[0]!.progress).toBe(20);
  });

  it("resolves crm:mqls auto_source (count of MQL rows)", async () => {
    seedObjective("obj-1");
    seedKeyResult("kr-1", "obj-1", { target: 100, auto_source: "crm:mqls" });
    metrics.leadScores.push(
      { id: "s1", project_id: "proj-1", is_mql: true },
      { id: "s2", project_id: "proj-1", is_mql: true },
      { id: "s3", project_id: "proj-1", is_mql: false },
    );

    const result = await service.autoUpdateProgress("proj-1");
    expect(result).toBe(1);
    expect(store.keyResults[0]!.current).toBe(2);
  });

  it("resolves crm:contacts auto_source", async () => {
    seedObjective("obj-2");
    seedKeyResult("kr-2", "obj-2", { title: "Total contacts", target: 500, unit: "contacts", auto_source: "crm:contacts" });
    metrics.contacts.push(
      { id: "c1", project_id: "proj-1" },
      { id: "c2", project_id: "proj-1" },
      { id: "c3", project_id: "proj-1" },
    );

    const result = await service.autoUpdateProgress("proj-1");
    expect(result).toBe(1);
    expect(store.keyResults[0]!.current).toBe(3);
  });

  it("resolves deals:pipeline auto_source (sum of amounts)", async () => {
    seedObjective("obj-3");
    seedKeyResult("kr-3", "obj-3", { title: "Pipeline value", target: 1000000, unit: "yen", auto_source: "deals:pipeline" });
    metrics.deals.push(
      { project_id: "proj-1", amount: 100000 },
      { project_id: "proj-1", amount: 200000 },
      { project_id: "proj-1", amount: 150000 },
    );

    const result = await service.autoUpdateProgress("proj-1");
    expect(result).toBe(1);
    expect(store.keyResults[0]!.current).toBe(450000);
  });

  it("resolves mailchimp:subscribers auto_source (latest campaign)", async () => {
    seedObjective("obj-4");
    seedKeyResult("kr-4", "obj-4", { title: "Subscriber count", target: 5000, unit: "subscribers", auto_source: "mailchimp:subscribers" });
    metrics.campaigns.push(
      { project_id: "proj-1", subscriber_count: 1000, created_at: "2026-01-01" },
      { project_id: "proj-1", subscriber_count: 3200, created_at: "2026-05-01" },
    );

    const result = await service.autoUpdateProgress("proj-1");
    expect(result).toBe(1);
    expect(store.keyResults[0]!.current).toBe(3200);
  });

  it("handles provider errors gracefully (no update)", async () => {
    seedObjective("obj-5");
    seedKeyResult("kr-5", "obj-5", { title: "Fails", auto_source: "ga4:sessions" });
    const failing = new OkrService({
      store,
      providers: {
        "ga4:sessions": async () => {
          throw new Error("DB connection failed");
        },
      },
    });

    const result = await failing.autoUpdateProgress("proj-1");
    expect(result).toBe(0);
    expect(store.keyResults[0]!.current).toBe(0);
  });

  it("returns 0 when auto_source has no registered provider", async () => {
    seedObjective("obj-6");
    seedKeyResult("kr-6", "obj-6", { auto_source: "unknown:metric" });
    const result = await service.autoUpdateProgress("proj-1");
    expect(result).toBe(0);
  });

  it("does not update when resolved value equals current", async () => {
    seedObjective("obj-7");
    seedKeyResult("kr-7", "obj-7", { target: 10, current: 3, auto_source: "crm:contacts" });
    metrics.contacts.push(
      { id: "c1", project_id: "proj-1" },
      { id: "c2", project_id: "proj-1" },
      { id: "c3", project_id: "proj-1" },
    );
    const result = await service.autoUpdateProgress("proj-1");
    expect(result).toBe(0);
  });
});
