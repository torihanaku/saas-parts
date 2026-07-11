/**
 * Ported from dev-dashboard-v2 `tests/gdpr-exporter.test.ts`,
 * adapted to the injected GdprStore + caller-supplied export targets.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createGdprExporter,
  convertToCsv,
  InMemoryGdprStore,
  silentGdprLogger,
  type ExportTarget,
} from "./index";

const TARGETS: ExportTarget[] = [
  { table: "app_user_config", column: "user_id", label: "settings" },
  { table: "app_content_drafts", column: "author", label: "content_drafts" },
  { table: "app_team_members", column: "email", label: "team_memberships" },
  { table: "app_usage", column: "user_id", label: "usage_history" },
];

let store: InMemoryGdprStore;

beforeEach(() => {
  store = new InMemoryGdprStore();
});

describe("exportUserData", () => {
  it("collects data from all tables", async () => {
    for (const t of TARGETS) {
      store.seed(t.table, [
        { [t.column]: t.column === "email" ? "user@test.com" : "user@test.com", name: "test" },
      ]);
    }
    const exporter = createGdprExporter({ store, exportTargets: TARGETS, logger: silentGdprLogger });
    const result = await exporter.exportUserData("user@test.com", "user@test.com");

    expect(result.userId).toBe("user@test.com");
    expect(result.format).toBe("json");
    expect(result.exportedAt).toBeDefined();
    expect(Object.keys(result.tables)).toContain("settings");
    expect(Object.keys(result.tables)).toContain("content_drafts");
    expect(Object.keys(result.tables)).toContain("usage_history");
    expect(result.tables["settings"]!.count).toBe(1);
  });

  it("handles missing tables gracefully", async () => {
    for (const t of TARGETS) store.missingTables.add(t.table);
    const exporter = createGdprExporter({ store, exportTargets: TARGETS, logger: silentGdprLogger });
    const result = await exporter.exportUserData("user@test.com", "user@test.com");
    for (const section of Object.values(result.tables)) {
      expect(section.count).toBe(0);
      expect(section.rows).toEqual([]);
    }
  });

  it("is best-effort: a throwing store yields empty sections", async () => {
    vi.spyOn(store, "selectRows").mockRejectedValue(new Error("db down"));
    const exporter = createGdprExporter({ store, exportTargets: TARGETS, logger: silentGdprLogger });
    const result = await exporter.exportUserData("u", "u@test.com");
    for (const section of Object.values(result.tables)) {
      expect(section.count).toBe(0);
    }
  });

  it("passes the configured row limit to the store", async () => {
    const selectSpy = vi.spyOn(store, "selectRows");
    const exporter = createGdprExporter({
      store,
      exportTargets: TARGETS,
      logger: silentGdprLogger,
      rowLimit: 500,
    });
    await exporter.exportUserData("u", "u@test.com");
    expect(selectSpy.mock.calls[0]![3]).toEqual({ limit: 500, orderByCreatedAtDesc: true });
  });
});

describe("convertToCsv", () => {
  it("converts export data to CSV format", () => {
    const data = {
      exportedAt: "2026-04-13T00:00:00Z",
      userId: "user@test.com",
      format: "json" as const,
      tables: {
        settings: {
          count: 1,
          rows: [{ user_id: "user@test.com", plan: "free", industry: "tech" }],
        },
        analytics: {
          count: 0,
          rows: [],
        },
      },
    };

    const csv = convertToCsv(data);
    expect(csv).toContain("# settings");
    expect(csv).toContain("user_id,plan,industry");
    expect(csv).toContain("user@test.com,free,tech");
    expect(csv).not.toContain("# analytics");
  });

  it("escapes commas and quotes in CSV values", () => {
    const data = {
      exportedAt: "2026-04-13T00:00:00Z",
      userId: "user@test.com",
      format: "json" as const,
      tables: {
        test: {
          count: 1,
          rows: [{ name: 'value with "quotes" and, commas' }],
        },
      },
    };

    const csv = convertToCsv(data);
    expect(csv).toContain('"value with ""quotes"" and, commas"');
  });
});
