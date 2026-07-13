/**
 * @torihanaku/sql-generator — 自然言語→安全な読み取り専用SQL（NL→SQL）
 *
 * Uses an injected LLM callback to convert natural language questions into
 * safe, read-only BigQuery SQL queries. Includes schema discovery from
 * INFORMATION_SCHEMA (via an injected query runner) and regex-based safety
 * validation (SELECT-only enforcement).
 *
 * Usage:
 *   import { discoverSchema, generateSql, validateSql } from "@torihanaku/sql-generator";
 *   const schemas = await discoverSchema(runQuery, "my-project", "my_dataset");
 *   const { sql, explanation } = await generateSql(generateJson, "月別売上", schemas);
 *   const { valid, sanitizedSql } = validateSql(sql);
 *
 * Ported from dev-dashboard-v2 server/lib/sql-generator.ts.
 * 変更点: BigQueryクライアント→ `SchemaQueryRunner` 注入、Claude API直呼び→
 * `JsonGenerator` コールバック注入（@torihanaku/claude-api の `generateJson` が適合）。
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TableSchema {
  tableName: string;
  columns: { name: string; type: string }[];
}

export interface SqlGenerationResult {
  sql: string;
  explanation: string;
}

export interface SqlValidationResult {
  valid: boolean;
  error?: string;
  sanitizedSql?: string;
}

/**
 * Injected query runner for schema discovery. Given a SQL string, returns the
 * result rows (e.g. a thin wrapper over `@google-cloud/bigquery`'s
 * `bq.query(sql)` or any other warehouse client).
 */
export type SchemaQueryRunner = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Injected JSON-mode LLM callback. `@torihanaku/claude-api` の
 * `ClaudeApiClient#generateJson` がこのシグネチャを満たす（bindして渡す）。
 * Must return `fallback` on any error.
 */
export type JsonGenerator = <T>(
  system: string,
  userPrompt: string,
  fallback: T,
  options?: { maxTokens?: number },
) => Promise<T>;

// ─── Dangerous statement pattern ─────────────────────────────────────────────

export const DANGEROUS_KEYWORDS_RE =
  /\b(CREATE|DROP|ALTER|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|CALL|EXECUTE|EXPORT|LOAD|REPLACE|DECLARE|BEGIN|COMMIT|ROLLBACK|ASSERT)\b/i;

export const VALID_START_RE = /^\s*(SELECT|WITH)\b/i;

/**
 * Matches an internal statement separator — a `;` that is followed by any
 * further non-whitespace content. A single trailing `;` is allowed; anything
 * after it (a second statement) is rejected. This is the primary defense
 * against multi-statement injection where a benign `SELECT` prefix is followed
 * by a mutating/exfiltrating statement (e.g. `SELECT 1; CALL proc()` or
 * `SELECT 1; EXPORT DATA ... AS SELECT * FROM secrets`).
 */
export const MULTI_STATEMENT_RE = /;\s*\S/;

export const LIMIT_RE = /\bLIMIT\s+\d+/i;

export const MAX_RESULT_LIMIT = 1000;

// ─── Schema Discovery ────────────────────────────────────────────────────────

/**
 * Discover table schemas from BigQuery INFORMATION_SCHEMA.
 * Queries the COLUMNS view (via the injected runner) and groups results by
 * table name. Returns [] when the query fails.
 */
export async function discoverSchema(
  runQuery: SchemaQueryRunner,
  projectId: string,
  datasetId: string,
): Promise<TableSchema[]> {
  const sql = `
SELECT table_name, column_name, data_type
FROM \`${projectId}.${datasetId}.INFORMATION_SCHEMA.COLUMNS\`
ORDER BY table_name, ordinal_position`;

  let result: { rows: Record<string, unknown>[] };
  try {
    result = await runQuery(sql);
  } catch (e) {
    console.error(
      "[SqlGenerator] discoverSchema failed:",
      e instanceof Error ? e.message : String(e),
    );
    return [];
  }

  // Group rows by table_name
  const tableMap = new Map<string, { name: string; type: string }[]>();

  for (const row of result.rows) {
    const tableName = String(row.table_name ?? "");
    const columnName = String(row.column_name ?? "");
    const dataType = String(row.data_type ?? "");

    if (!tableName || !columnName) continue;

    if (!tableMap.has(tableName)) {
      tableMap.set(tableName, []);
    }
    tableMap.get(tableName)!.push({ name: columnName, type: dataType });
  }

  const schemas: TableSchema[] = [];
  for (const [tableName, columns] of tableMap) {
    schemas.push({ tableName, columns });
  }

  return schemas;
}

// ─── Schema Formatting ──────────────────────────────────────────────────────

/**
 * Format table schemas as readable text for inclusion in an LLM prompt.
 */
export function formatSchemaForPrompt(schemas: TableSchema[]): string {
  if (!schemas.length) return "No tables found.";

  const parts: string[] = [];

  for (const schema of schemas) {
    const columnLines = schema.columns
      .map((col) => `  - ${col.name} (${col.type})`)
      .join("\n");
    parts.push(`Table: ${schema.tableName}\n${columnLines}`);
  }

  return parts.join("\n\n");
}

// ─── SQL Generation ─────────────────────────────────────────────────────────

export const SQL_GENERATION_SYSTEM = `You are a BigQuery SQL expert. Given a natural language question and a database schema, generate a safe, read-only SQL query.

Rules:
- Only SELECT statements allowed. No DDL or DML (CREATE, DROP, INSERT, UPDATE, DELETE, etc.)
- Add LIMIT 1000 if no LIMIT clause is specified
- Use standard BigQuery SQL syntax
- Reference tables with fully qualified names when possible
- Return valid JSON only: { "sql": "SELECT ...", "explanation": "This query ..." }`;

const SQL_GENERATION_FALLBACK: SqlGenerationResult = {
  sql: "",
  explanation: "",
};

/**
 * Generate a BigQuery SQL query from a natural language question via the
 * injected LLM callback. Returns { sql, explanation } on success, or empty
 * strings on failure (the callback's fallback contract).
 */
export async function generateSql(
  generateJson: JsonGenerator,
  question: string,
  schema: TableSchema[],
  projectContext?: string,
): Promise<SqlGenerationResult> {
  const schemaText = formatSchemaForPrompt(schema);

  const promptParts: string[] = [
    `## Database Schema\n${schemaText}`,
    `## Question\n${question}`,
  ];

  if (projectContext) {
    promptParts.push(`## Additional Context\n${projectContext}`);
  }

  const userPrompt = promptParts.join("\n\n");

  return generateJson<SqlGenerationResult>(
    SQL_GENERATION_SYSTEM,
    userPrompt,
    SQL_GENERATION_FALLBACK,
    { maxTokens: 2000 },
  );
}

// ─── SQL Validation ─────────────────────────────────────────────────────────

/**
 * Validate a SQL query for safety (read-only, no destructive statements).
 *
 * - Rejects any DDL/DML keywords (CREATE, DROP, ALTER, INSERT, UPDATE, DELETE, etc.)
 * - Must start with SELECT or WITH (after trimming)
 * - Automatically appends LIMIT 1000 if no LIMIT clause is present
 *
 * Returns { valid: true, sanitizedSql } on success or { valid: false, error } on failure.
 */
export function validateSql(sql: string): SqlValidationResult {
  const trimmed = sql.trim();

  if (!trimmed) {
    return { valid: false, error: "Empty SQL query" };
  }

  // Reject multi-statement SQL. Only a single statement (with an optional
  // trailing `;`) is allowed. This blocks `SELECT ...; <mutating statement>`
  // injection even when the second statement's keyword is obfuscated or not in
  // the blocklist below (defense in depth).
  if (MULTI_STATEMENT_RE.test(trimmed)) {
    return {
      valid: false,
      error: "Multiple SQL statements are not allowed. Only a single read-only query is permitted.",
    };
  }

  // Check for dangerous keywords
  if (DANGEROUS_KEYWORDS_RE.test(trimmed)) {
    const match = trimmed.match(DANGEROUS_KEYWORDS_RE);
    return {
      valid: false,
      error: `Forbidden SQL keyword detected: ${match?.[0]?.toUpperCase()}. Only read-only queries are allowed.`,
    };
  }

  // Must start with SELECT or WITH
  if (!VALID_START_RE.test(trimmed)) {
    return {
      valid: false,
      error: "Query must start with SELECT or WITH",
    };
  }

  // Append LIMIT if not present
  let sanitizedSql = trimmed;
  if (!sanitizedSql.endsWith(";")) {
    // no trailing semicolon — append LIMIT directly
    if (!LIMIT_RE.test(sanitizedSql)) {
      sanitizedSql = `${sanitizedSql}\nLIMIT ${MAX_RESULT_LIMIT}`;
    }
  } else {
    // Remove trailing semicolon, check for LIMIT, then re-add
    const withoutSemicolon = sanitizedSql.slice(0, -1).trim();
    if (!LIMIT_RE.test(withoutSemicolon)) {
      sanitizedSql = `${withoutSemicolon}\nLIMIT ${MAX_RESULT_LIMIT}`;
    } else {
      sanitizedSql = withoutSemicolon;
    }
  }

  return { valid: true, sanitizedSql };
}
