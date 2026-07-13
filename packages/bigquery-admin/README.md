# @torihanaku/bigquery-admin

テナント別に暗号化保存された BigQuery サービスアカウントキーの管理（保存/取得/削除・AES-256-GCM）＋設定解決（テナント設定 → フォールバック認証情報）＋クエリ実行/接続テスト。

移植元: 実運用SaaS `server/lib/bigquery-client.ts`（+ `server/lib/token.ts` の encrypt/decrypt をインライン移植）

## 特徴

- **SDK 依存ゼロ**: `@google-cloud/bigquery` は import しない。構造的インターフェース `BigQueryLike` と `clientFactory` 注入で接続（`new BigQuery({credentials, projectId})` のインスタンスがそのまま適合）
- **ストア注入**: テナント設定の永続化は `BigQuerySettingsStore`（get/insert/patch/delete）を実装して渡す（Supabase REST / PG / Firestore 等なんでも可）
- **鍵の暗号化**: サービスアカウント JSON は保存前に AES-256-GCM で暗号化（`iv:authTag:ciphertext` 形式、鍵は `encryptionSecret` から HMAC-SHA256 派生 — 移植元 token.ts と同一方式・同一フォーマット）
- **復号値は外に出さない**: `resolveConfig` の返り値（メモリ内）以外で復号された鍵を返す API はない。設定行を画面に返すときは `service_account_key_encrypted` を必ず redact すること

## 使い方

```ts
import { BigQuery } from "@google-cloud/bigquery"; // アプリ側でだけ依存
import { createBigQueryAdmin, type BigQuerySettingsStore } from "@torihanaku/bigquery-admin";

const store: BigQuerySettingsStore = {
  get: (tenantId) => db.selectOne("bigquery_settings", { tenant_id: tenantId }),
  insert: async (row) => ({ ok: await db.insert("bigquery_settings", row) }),
  patch: async (tenantId, patch) => ({ ok: await db.update("bigquery_settings", { tenant_id: tenantId }, patch) }),
  delete: async (tenantId) => ({ ok: await db.delete("bigquery_settings", { tenant_id: tenantId }) }),
};

const bq = createBigQueryAdmin({
  store,
  clientFactory: (o) => new BigQuery(o),
  encryptionSecret: env.SESSION_SECRET,
  fallback: { // セルフホスト向け（元実装の GOOGLE_SERVICE_ACCOUNT_KEY / GOOGLE_CLOUD_PROJECT 相当）
    serviceAccountKey: env.GOOGLE_SERVICE_ACCOUNT_KEY,
    projectId: env.GOOGLE_CLOUD_PROJECT,
  },
});

await bq.saveSettings("tenant-1", { service_account_key: keyJson, project_id: "my-proj" }); // 暗号化して upsert
const config = await bq.resolveConfig("tenant-1"); // テナント設定 → fallback → null
if (config) {
  await bq.testConnection(config);                 // { ok } / { ok:false, error }
  const { rows, totalRows } = await bq.runQuery(config, "SELECT ...", { p1: "v" });
}
```

## 設定解決の優先順位（移植元と同一）

1. ストアのテナント設定（`enabled` かつ復号成功時）
2. `fallback.serviceAccountKey`（projectId は `fallback.projectId` → credentials.project_id → ""）
3. `null`（未設定）

billing_dataset / billing_table の既定値は `billing_export` / `gcp_billing_export_v1_FULL`（`defaults` オプションで変更可）。

## 変更点（移植元との差分）

- Supabase REST ヘルパー直接呼び出し → `BigQuerySettingsStore` 注入
- `@google-cloud/bigquery` import → `BigQueryLike` 構造的型 + `clientFactory` 注入
- token.ts の encrypt/decrypt import → crypto.ts に private コピー（`encryptionSecret` 引数化）
- `env.GOOGLE_SERVICE_ACCOUNT_KEY` フォールバック → `fallback` オプション
- console.error 直書き → `logError` 注入可（default は console.error）

## ランタイム要件

- Node.js（`node:crypto` 使用）。peerDeps なし。BigQuery SDK はアプリ側依存。
