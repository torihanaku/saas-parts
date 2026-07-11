# @torihanaku/audit-log

**用途**: SHA-256 ハッシュチェーン付きの改ざん検知可能な監査ログ（append-only）を記録・検証するモジュール（ISMAP / SOC2 CC7.2 対応の土台）。

## 主要API例

```ts
import {
  createAuditLogger,
  verifyHashChain,
  InMemoryAuditStore,
  type AuditStore,
  type AuditContext,
} from "@torihanaku/audit-log";

// 1) ストアとコンテキストを注入してロガーを作る
const store = new InMemoryAuditStore(); // 本番は Supabase/Postgres 実装を注入
const context: AuditContext = {
  getCurrentUserRole: async (req) => ({ email: "user@example.com", role: "admin" }),
  getTenantId: async (req) => "tenant-uuid",
};
const audit = createAuditLogger({ store, context });

// 2) リクエスト起点のイベント（必ず await する）
await audit.logAudit(req, {
  action: "update",           // 既定の action union（DefaultAuditAction）
  resourceType: "task",
  resourceId: "task-123",
  changes: { status: "done" },
  riskLevel: "medium",        // low(既定)/medium/high/critical
});

// 3) システムアクター起点のイベント
await audit.logAuditSystem("tenant-uuid", {
  action: "agent_auto_halt",
  resourceType: "agent",
});

// 4) 独自 action を使う場合はジェネリクスで拡張
const custom = createAuditLogger<"billing_charged" | "plan_changed">({ store, context });

// 5) 改ざん検知（チェーン全体をリプレイして検証。破損時は throw）
await verifyHashChain(store, "tenant-uuid"); // => true
```

## 依存

- なし（`node:crypto` のみ）。peerDependencies なし。

## 注入ポイント

| 注入先 | 型 | 元実装での実体 |
|---|---|---|
| `store` | `AuditStore`（`getLastEntry` / `insert` / `listEntries`） | Supabase REST の `audit_log` テーブル（RLS で append-only） |
| `context` | `AuditContext`（`getCurrentUserRole` / `getTenantId`） | `server/lib/auth.ts` |
| `defaultTenantId` | `string` | 全ゼロ UUID（元実装のフォールバック値をそのまま既定に） |

同梱の `InMemoryAuditStore` はテスト・ローカル用リファレンス実装。

## 重要な互換性メモ

- 正規化 JSON（`JSON.stringify(obj, Object.keys(obj).sort())`）は**元実装とバイト互換**。既存データのチェーン検証互換性を守るため変更禁止。
  - replacer 配列の仕様上、ネストしたオブジェクト（`changes` 等）は `{}` にシリアライズされる挙動も元実装のまま保存している。
- 検証側は `id` / `prev_hash` / `entry_hash` を除外して再計算する（元実装の WORM exporter と同一）。
- ストア実装は「`occurred_at` 降順の最新1件」「`occurred_at` 昇順の全件」を元実装のクエリと同じ順序規則で返すこと。

## 想定ランタイム

Node.js 18+（`Buffer` / `node:crypto` / fetch API `Request` を使用）。Bun も可。ブラウザ不可。

## 出典パス

- `dev-dashboard-v2/server/lib/audit.ts`（ロガー本体 約133行）
- `dev-dashboard-v2/server/lib/audit-worm-exporter.ts`（`verifyHashChain` 検証ロジック 約33行）
- テスト出典: `dev-dashboard-v2/tests/audit.test.ts`
