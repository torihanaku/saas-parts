# @torihanaku/saas-inventory

組織（プロジェクト／テナント）の **SaaS 利用棚卸し**。ツール一覧の CRUD、月額コスト集計、integration からの自動検出、重複検知を行います。実運用SaaS の `saas-inventory.ts` から抽出しました。

- **永続化 → store 注入** (`InventoryStore`)。実運用SaaS では Supabase (`dd_saas_inventory`) でした。
- **自動検出のソース → 注入** (`IntegrationSource`)。元は Nango の `getIntegrationStatus`。
- ロジック（CRUD・カテゴリ写像・spend 集計）は原文どおり移植しています。

## 使い方

```ts
import { createSaaSInventory, type InventoryStore } from "@torihanaku/saas-inventory";

const store: InventoryStore = {
  list: (projectId) => db.select(projectId),
  findByTool: (projectId, tool) => db.findOne(projectId, tool),
  insert: (item) => db.insert(item),
  patch: (id, patch) => db.update(id, patch),
};

const inventory = createSaaSInventory({
  store,
  integrations: () => nango.getIntegrationStatus(), // detectSaaSFromIntegrations を使う場合のみ
});

await inventory.upsertSaaSItem({ project_id: "p1", tool_name: "notion", monthly_cost: 100 });
const summary = await inventory.getSaaSSpendSummary("p1"); // { total_monthly, by_category }
const detected = await inventory.detectSaaSFromIntegrations("p1"); // 接続済みを自動登録
const dupes = await inventory.findDuplicates("p1"); // 表記ゆれ含む重複グループ
```

## API

| メソッド | 説明 |
|---|---|
| `getSaaSInventory(projectId)` | ツール一覧を返す |
| `upsertSaaSItem(item)` | (project, tool_name) で upsert。存在すれば patch、無ければ insert |
| `detectSaaSFromIntegrations(projectId)` | 接続済み integration を検出し `auto_detected` メタ付きで登録 |
| `getSaaSSpendSummary(projectId)` | `active` のみでカテゴリ別・合計の月額を集計 |
| `findDuplicates(projectId)` | tool_name を正規化（trim + 小文字化）して重複グループを返す |

## カテゴリ写像

自動検出時のツール → カテゴリは `TOOL_CATEGORY_MAP`（既定）を使います。`createSaaSInventory({ categoryMap })` で差し替え可能です。未知のツールは `other` になります。

## 出典

- `server/lib/saas-inventory.ts`

Supabase 直アクセスと Nango 依存はストア／ソース注入に置換し、`findDuplicates`（重複検知）を追加しています。
