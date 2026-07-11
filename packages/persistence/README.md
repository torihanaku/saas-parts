# @torihanaku/persistence

注入されたDAL（PostgRESTスタイルのDBラッパー）の上で動く、スコープ付き汎用CRUD層 `PersistenceLayer<T>`（list/get/save/update/remove・ソフトデリート・updated_at自動付与）。

## 主要API

```ts
import {
  PersistenceLayer,
  projectLayer, userLayer, tenantLayer,
  upsert, batchInsert,
  type DalClient,
} from "@torihanaku/persistence";

// DALを注入（@torihanaku/supabase-dal の SupabaseDal は構造的にこの形を満たす）
const dal: DalClient = {
  get: (table, query) => supabase.get(table, query),
  insert: (table, data) => supabase.insert(table, data),
  patch: (table, filter, data) => supabase.patch(table, filter, data),
};

// テーブル名・スコープ列は全て呼び出し側が指定（ハードコードなし）
const layer = new PersistenceLayer<BacklogItem>(dal, "backlog_items", "project_id", "my-project");
// または: projectLayer(dal, "backlog_items", "my-project")  // project_id スコープ
//         userLayer(dal, "user_items", userId)              // user_id スコープ
//         tenantLayer(dal, "tenant_items", tenantId, { softDelete: true }) // tenant_id スコープ

await layer.save({ id: "abc", title: "Do something", status: "pending" }); // スコープ列を自動付与
const items = await layer.list("order=created_at.desc");
const one = await layer.get("abc");
await layer.update("abc", { status: "done" });   // updated_at を自動付与
await layer.remove("abc");
// remove の挙動: softDelete=true → status="deleted" にPATCH
//               デフォルト     → deleted=true + deleted_at にPATCH（真のDELETEは発行しない。必要なら dal.delete を直接呼ぶ）

// 0〜1行のsettings系テーブル向け upsert（存在すればPATCH、なければINSERT）
await upsert(dal, "settings", "project_id=eq.p1", { theme: "dark" });

// 一括INSERT（成功件数を返す・失敗は握りつぶさずカウントから除外）
const okCount = await batchInsert(dal, "events", records);
```

## 依存

なし（`DalClient` インターフェースは本パッケージ内でローカル定義。他の @torihanaku/* パッケージへのimportなし）。

## 設定ポイント（何を注入するか）

- `DalClient`（必須）: `get(table, query)` / `insert(table, data)` / `patch(table, filter, data)` の3メソッド（`delete` はオプション）。query/filter は PostgREST形式の文字列（`id=eq.1&limit=1` 等）
- テーブル名・スコープ列（filterColumn）・スコープ値は全てコンストラクタ引数
- 全メソッドはthrowしない（失敗時は `[]` / `null` / `false` を返すフェイルソフト設計。元実装と同じ）

## 想定ランタイム

any（I/Oは全て注入されたDAL経由。Date/Promiseのみ使用）

## 出典

dev-dashboard-v2 `server/lib/persistence-layer.ts`（テストは `tests/persistence-layer.test.ts` から移植）。
