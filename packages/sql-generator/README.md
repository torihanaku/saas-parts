# @torihanaku/sql-generator

自然言語の質問を安全な読み取り専用SQL（BigQuery方言）に変換するNL→SQLパイプライン。プロンプト構築＋スキーマ探索（INFORMATION_SCHEMA）＋正規表現ベースのSQL安全性バリデーション（SELECT限定強制）を提供。

## 主要API

```ts
import {
  discoverSchema,
  generateSql,
  validateSql,
  formatSchemaForPrompt,
  type SchemaQueryRunner,
  type JsonGenerator,
} from "@torihanaku/sql-generator";

// 1) スキーマ探索 — クエリランナーを注入（BigQuery等のクライアントを薄くラップ）
const runQuery: SchemaQueryRunner = async (sql) => {
  const [rows] = await bq.query(sql); // @google-cloud/bigquery
  return { rows };
};
const schemas = await discoverSchema(runQuery, "my-project", "my_dataset");
// => [{ tableName: "users", columns: [{ name: "id", type: "INT64" }, ...] }, ...]

// 2) NL→SQL生成 — LLMコールバックを注入
// @torihanaku/claude-api の ClaudeApiClient#generateJson がそのまま適合する:
import { ClaudeApiClient } from "@torihanaku/claude-api";
const client = new ClaudeApiClient({ apiKey });
const generateJson: JsonGenerator = client.generateJson.bind(client);

const { sql, explanation } = await generateSql(generateJson, "月別売上を出して", schemas);

// 3) 安全性バリデーション（LLM出力は必ず通すこと）
const { valid, sanitizedSql, error } = validateSql(sql);
if (valid) await bq.query(sanitizedSql!);
```

### SQL安全性バリデータ（単独利用可）

`validateSql` は生成とは独立して使える純粋関数。判定に使う正規表現も個別エクスポート。

- `DANGEROUS_KEYWORDS_RE` — CREATE/DROP/ALTER/TRUNCATE/INSERT/UPDATE/DELETE/MERGE/GRANT/REVOKE を拒否
- `VALID_START_RE` — 先頭が SELECT / WITH であることを強制
- `LIMIT_RE` / `MAX_RESULT_LIMIT` — LIMIT句が無ければ `LIMIT 1000` を自動付与（末尾セミコロンは除去）

## 注入ポイント

- **`SchemaQueryRunner`**: `(sql) => Promise<{ rows }>`。BigQueryに限らず INFORMATION_SCHEMA.COLUMNS 互換のビューを持つDWHなら差し替え可
- **`JsonGenerator`**: `(system, userPrompt, fallback, { maxTokens }) => Promise<T>`。エラー時は fallback（`{ sql: "", explanation: "" }`）を返す契約。`@torihanaku/claude-api` の `generateJson` が満たす
- `SQL_GENERATION_SYSTEM`（システムプロンプト）はエクスポート済みで、呼び出し側での拡張・差し替えの参考にできる
- APIキー・認証情報はこのパッケージでは扱わない（注入したクライアント側の責務）

## Runtime

- 依存ゼロ（`console.error` を除きI/Oなし）。Node / Bun / ブラウザいずれでも動作
- 生成SQLの実行はこのパッケージの責務外（必ず `validateSql` を通してから実行すること）

## 出典

- `実運用SaaS/server/lib/sql-generator.ts` の移植（テストは `tests/sql-generator.test.ts` から移植し注入フェイクに置換）
- 変更点: `bigquery-client` 依存→ `SchemaQueryRunner` 注入、`claude-api-client.generateJson` 直import→ `JsonGenerator` 注入、安全性正規表現4定数を公開エクスポート化
