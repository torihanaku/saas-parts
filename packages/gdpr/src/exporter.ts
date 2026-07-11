/**
 * GDPR Data Exporter — collect all user data for portability export.
 * Ported from dev-dashboard-v2 `server/lib/gdpr-exporter.ts`.
 * EXPORT_TARGETS is now caller-supplied config; persistence is an
 * injected `GdprStore`. CSV escaping preserved exactly.
 */
import type { GdprStore } from "./store";
import { consoleGdprLogger, type GdprLogger } from "./logger";

export interface ExportTarget {
  table: string;
  column: string;
  /** Section label used as the key in the export result. */
  label: string;
}

/**
 * Documented example manifest (renamed from the source's app-specific list).
 * Columns named "email" are matched against the email argument;
 * every other column is matched against userId (source behavior).
 */
export const EXAMPLE_EXPORT_TARGETS: ExportTarget[] = [
  { table: "app_user_config", column: "user_id", label: "settings" },
  { table: "app_content_drafts", column: "author", label: "content_drafts" },
  { table: "app_team_members", column: "email", label: "team_memberships" },
  { table: "app_usage", column: "user_id", label: "usage_history" },
];

export interface ExportResult {
  exportedAt: string;
  userId: string;
  format: "json" | "csv";
  tables: Record<string, { count: number; rows: Record<string, unknown>[] }>;
}

export interface GdprExporterOptions {
  store: GdprStore;
  /** Tables to export (source: EXPORT_TARGETS). */
  exportTargets: ExportTarget[];
  logger?: GdprLogger;
  /** Max rows fetched per table. Source: 10,000. */
  rowLimit?: number;
}

export interface GdprExporter {
  exportUserData(userId: string, email: string): Promise<ExportResult>;
}

export function createGdprExporter(options: GdprExporterOptions): GdprExporter {
  const { store, exportTargets } = options;
  const logger = options.logger ?? consoleGdprLogger;
  const rowLimit = options.rowLimit ?? 10_000;

  async function fetchTableData(
    table: string,
    column: string,
    value: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      return await store.selectRows(table, column, value, {
        limit: rowLimit,
        orderByCreatedAtDesc: true,
      });
    } catch {
      /* best-effort */
    }
    return [];
  }

  async function exportUserData(userId: string, email: string): Promise<ExportResult> {
    logger.info("gdpr", `Starting data export for ${userId}`);

    const tables: ExportResult["tables"] = {};

    for (const target of exportTargets) {
      const value = target.column === "email" ? email : userId;
      const rows = await fetchTableData(target.table, target.column, value);
      tables[target.label] = { count: rows.length, rows };
    }

    logger.info("gdpr", `Export complete for ${userId}`);
    return { exportedAt: new Date().toISOString(), userId, format: "json", tables };
  }

  return { exportUserData };
}

/** Convert an export result to sectioned CSV. Escaping preserved from the source. */
export function convertToCsv(data: ExportResult): string {
  const sections: string[] = [];

  for (const [label, { rows }] of Object.entries(data.tables)) {
    if (rows.length === 0) continue;
    const headers = Object.keys(rows[0]!);
    const csvRows = rows.map((row) =>
      headers
        .map((h) => {
          const val = row[h];
          if (val === null || val === undefined) return "";
          const str = typeof val === "object" ? JSON.stringify(val) : String(val);
          return str.includes(",") || str.includes('"') || str.includes("\n")
            ? `"${str.replace(/"/g, '""')}"`
            : str;
        })
        .join(","),
    );
    sections.push(`# ${label}\n${headers.join(",")}\n${csvRows.join("\n")}`);
  }

  return sections.join("\n\n");
}
