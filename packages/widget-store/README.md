# @torihanaku/widget-store

ダッシュボード／ウィジェットレイアウト／お気に入りの CRUD 永続化層。デイリーキャッシュ（日付キーで upsert）、ショット（履歴として insert）、ストック（保存版）、お気に入りウィジェット（UNIQUE upsert＋ピン留め順ソート）、シグナル要約の 13 メソッドを提供します。

ストレージは注入式の `WidgetStoreDriver` インターフェースに抽象化されており、インメモリ実装を同梱しています（Supabase / RDB / KV など任意のバックエンドを差し込めます）。

## 用途

- 「AI が組んだダッシュボード spec を、テナント×ユーザー単位でキャッシュ・履歴・保存版として永続化する」ワークフローの土台
- お気に入りウィジェットの CRUD（重複は `sourceWidgetId` で merge、`pinnedPosition` 昇順 → `createdAt` 降順で整列）
- 直近シグナルを LLM プロンプトに渡す 1 行要約テキストへの整形

## API 例

```ts
import {
  createWidgetStore,
  createInMemoryWidgetStoreDriver,
  todayDateKey,
} from "@torihanaku/widget-store";

// ドライバ省略時はインメモリ（プロセス内のみ永続）
const store = createWidgetStore();

// デイリーキャッシュ: (tenantId, userId, dateKey) で upsert → 取得
await store.persistDashboard("tenant-1", "user-1", {
  id: "d-1",
  kind: "daily",
  dateKey: todayDateKey(),
  generatedAt: new Date().toISOString(),
  widgets: [{ id: "w-1", type: "scorecard", title: "Sessions" }],
});
const cached = await store.fetchTodayCache("tenant-1", "user-1"); // spec | null

// ショット（質問への回答ダッシュボード）は履歴として積む
await store.persistShot("tenant-1", "user-1", spec, { question: "なぜ急増?" });

// ストック（保存版）と一覧
await store.persistStock("tenant-1", "user-1", { ...spec, kind: "stock" });
const stocks = await store.listStocks("tenant-1", "user-1"); // [{ id, title, createdAt, question }]

// お気に入り CRUD
const fav = await store.addFavorite("tenant-1", "user-1", {
  sourceWidgetId: "w-1",
  widgetSpec: { id: "w-1", type: "scorecard", title: "Sessions" },
  pinnedPosition: 0,
});
const items = await store.listFavoriteItems("tenant-1", "user-1");
await store.deleteFavorite("tenant-1", "user-1", fav!.id);

// デイリー自動組み込み用の軽量版（最大 4 件）
const widgets = await store.fetchFavorites("tenant-1", "user-1");

// シグナル要約（LLM プロンプト向けテキスト）
const summary = await store.fetchSignalSummary();
```

### 独自バックエンドの注入

```ts
import type { WidgetStoreDriver } from "@torihanaku/widget-store";

const driver: WidgetStoreDriver = {
  findDashboards: async (q) => {/* SELECT ... WHERE tenant_id=... */ return []; },
  insertDashboard: async (row) => {/* INSERT（履歴として積む） */},
  upsertDashboard: async (row) => {/* (tenantId,userId,dateKey) UNIQUE で upsert */},
  listSignals: async () => [],
  findFavorites: async (q) => [], // pinnedPosition asc(null last)→createdAt desc で整列して返す
  upsertFavorite: async (input) => null, // (tenantId,userId,sourceWidgetId) UNIQUE で merge
  deleteFavorite: async (q) => false,
};

const store = createWidgetStore({ driver, logger: (msg, err) => log.error(msg, err) });
```

## 設定

`createWidgetStore(options)`:

| オプション | 既定値 | 説明 |
|---|---|---|
| `driver` | インメモリ実装 | `WidgetStoreDriver` の任意実装 |
| `logger` | `console.error` | 書き込み失敗時のログ出力 |
| `now` | `() => new Date()` | タイムスタンプの時刻注入（テスト用） |

全メソッドは原典どおり**失敗時に throw しません**（読み取りは `null` / `[]` / 既定文字列、書き込みは logger に記録して黙って戻る）。

## Runtime

- Node.js 18+ / Bun / edge（`crypto.randomUUID` があれば利用、なければフォールバック）
- 外部依存なし・`process.env` 参照なし（キーや接続情報はドライバ実装側の責務）
- peerDependencies なし

## 出典

`実運用SaaS` の `server/lib/daily-dashboard-store.ts`（356 行, #721）。Supabase PostgREST 直叩き（`supabaseGet` / `fetch`）を `WidgetStoreDriver` 注入に置き換え、`dd_dashboards` / `dd_dashboard_widgets_favorites` / `v_dd_signals_24h` の概念を汎用の dashboard / favorite / signal 用語へ改名。フォールバック挙動・整列順・upsert 条件は原典を維持。
