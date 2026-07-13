# @torihanaku/gdpr

**用途**: GDPR/個情法対応のユーザーデータ削除（テーブル横断カスケード削除＋猶予期間チェック＋ベクター残渣検証）とデータポータビリティ書き出し（JSON/CSV）。

## 主要API例

```ts
import {
  createGdprExecutor,
  createGdprExporter,
  convertToCsv,
  InMemoryGdprStore,
  EXAMPLE_CASCADE_TARGETS,
  EXAMPLE_EXPORT_TARGETS,
} from "@torihanaku/gdpr";

const store = new InMemoryGdprStore(); // 本番は Supabase/Postgres 実装を注入

// ── 削除（executor）─────────────────────────────
const executor = createGdprExecutor({
  store,
  // 削除対象テーブルの台帳は呼び出し側の設定（column が "email" の行は
  // リクエストの email、それ以外は user_id で照合される — 元実装の挙動）
  cascadeTargets: [
    { table: "app_analytics", column: "user_id" },
    { table: "app_content_drafts", column: "author" },
    { table: "app_team_members", column: "email" },
  ],
  // 省略時は元実装のヒューリスティック
  // （テーブル名に embeddings/memory/dna を含む or nav_ で始まる）で導出
  residueTargets: [{ table: "doc_embeddings", column: "user_id" }],
});

// 猶予期間（元実装は30日）を過ぎた pending リクエストを実行
await executor.checkAndExecuteDeletions();

// 1件を即時実行（各テーブルの deleted/skipped/error ログを返す）
const log = await executor.executeDeletion({
  id: "req-1", user_id: "u-1", email: "a@example.com",
  status: "pending", scheduled_delete_at: new Date().toISOString(),
});

// 削除後のベクター残渣検証（残っていれば throw）
await executor.verifyNoVectorResidue("u-1");

// 常駐チェッカー（毎時＋起動30秒後に初回、元実装の既定値）
executor.startDeletionChecker();
executor.stopDeletionChecker();

// ── 書き出し（exporter）─────────────────────────
const exporter = createGdprExporter({ store, exportTargets: EXAMPLE_EXPORT_TARGETS });
const result = await exporter.exportUserData("u-1", "a@example.com"); // JSON
const csv = convertToCsv(result); // セクション区切りCSV（エスケープは元実装のまま）
```

## 依存

- なし。peerDependencies なし。

## 注入ポイント

| 注入先 | 型 | 元実装での実体 |
|---|---|---|
| `store` | `GdprStore`（`deleteRows` / `selectRows` / `listPendingDeletionRequests` / `markDeletionCompleted`） | Supabase REST 直叩き（fetch）＋ `supabasePatch`。`dashboard_deletion_requests` テーブル名はストア実装側に隠蔽 |
| `cascadeTargets` | `CascadeTarget[]` | ハードコードされた `CASCADE_TARGETS`（約40テーブル） |
| `residueTargets` | `CascadeTarget[]`（任意） | `CASCADE_TARGETS` からの名前ヒューリスティック（省略時は同じ導出を維持） |
| `exportTargets` | `ExportTarget[]` | ハードコードされた `EXPORT_TARGETS`（10テーブル） |
| `logger` | `GdprLogger`（任意、既定 console） | `server/lib/logger` の logInfo/logWarn/logError |
| `checkIntervalMs` / `startupDelayMs` / `rowLimit` | number（任意） | 3,600,000ms / 30,000ms / 10,000行（元実装の既定値） |

- `deleteRows` は「テーブル不存在（404/406）→ `table-missing`」を throw ではなく結果で返すこと（executor が "skipped" として記録する元実装の挙動）。
- `selectRows` はエクスポート用途では `created_at` 降順で返すこと（`orderByCreatedAtDesc` ヒント）。

## 想定ランタイム

Node.js 18+ / Bun。タイマー（setInterval/setTimeout）を使用。ブラウザ不可。

## 出典パス

- `実運用SaaS/server/lib/gdpr-executor.ts`（約277行）
- `実運用SaaS/server/lib/gdpr-exporter.ts`（約86行）
- テスト出典: `実運用SaaS/tests/gdpr-executor.test.ts` / `tests/gdpr-executor-cascade.test.ts` / `tests/gdpr-exporter.test.ts`

※ 元実装の `deleteExpiredApplications`（採用応募データの保持期限削除）はアプリ固有機能のため移植対象外。
