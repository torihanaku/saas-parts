# @torihanaku/daily-briefing

「毎朝の AI ブリーフィング」を編成するためのフレームワーク。**ウィジェットデータ収集 → LLM 要約 → パーソナライズ構成** の 3 段を、依存を注入して組み立てます。dev-dashboard-v2 の AI Daily Dashboard (#721) と Briefings ルートから抽出しました。

## 3 レイヤー

### 1. データソース registry (`sources.ts` / `registry.ts`)

`dataSource` 名（`ga4` / `costs` / `campaigns` / `sns`）→ 実データ取得の写像。DB アクセスは `TableQuery` を注入します（dev-dashboard-v2 の `supabaseGet(table, query)` がそのまま充足）。

```ts
import { createDefaultWidgetDataRegistry } from "@torihanaku/daily-briefing";

const registry = createDefaultWidgetDataRegistry(supabaseGet);
const costs = await registry.fetch("costs", { dateRange: "7d", limit: 10 }, tenantId);
// 未登録名は空応答 → UI が壊れない
```

テーブル名（`dd_ad_insights` 等、マーケ由来）は第 2 引数 `SourceTableConfig` で差し替え可能です。独自データソースは `registry.register(name, fetcher)` で追加できます。

### 2. ブリーフィング本文生成 (`briefing.ts`)

「活動メトリクス collector 群 → LLM で日本語ブリーフィング」を組み立てます。原文の 4 指標（レポート／下書き／バックログ／CRM）は `ActivityCollector` として渡します。collector は並列実行され、1 つが失敗しても他は反映されます。

```ts
import { generateBriefingContent, getYesterdayDate } from "@torihanaku/daily-briefing";

const content = await generateBriefingContent({
  date: getYesterdayDate(),
  apiKey, // tenant secret → env の解決は呼び出し側の責務
  collectors: [
    async (d) => ({ label: "レポート生成", count: await countReports(d) }),
    async (d) => ({ label: "下書き", count: c, detail: { label: "公開済み", count: p } }),
  ],
  generateText, // (apiKey, system, user, {maxTokens}) => Promise<string>
});
```

### 3. パーソナライズ構成 (`compose.ts`)

ユーザー文脈・シグナル・お気に入りを集め、LLM の構成呼び出し（`ComposeFn`）で `DashboardSpec` を生成します。HTTP ルーティング・認証・使用量制限・API キー解決・キャッシュ判定は呼び出し側の責務として除外しています。

```ts
import { composeDailyBriefing, composeShot, ComposeError } from "@torihanaku/daily-briefing";

const spec = await composeDailyBriefing(apiKey, {
  compose: composeDashboard, // dev-dashboard-v2 の composeDashboard
  getUserContext: async () => formatUserContext(await buildUserContext(userId)),
  getSignalSummary: async () => await fetchSignalSummary(),
  getFavorites: async () => await fetchFavorites(tenantId, userId),
});
// 0 ウィジェット / 例外は ComposeError (code: compose_returned_no_widgets | compose_failed)
```

## 永続化・レイアウト

`DashboardSpec` のキャッシュ保存・お気に入り・レイアウト永続化は **`@torihanaku/widget-store`** が担います（本パッケージは import しません）。`composeDailyBriefing` の出力を widget-store の `saveDashboard` 等に渡してください。

## 出典

- `server/lib/widget-data/sources.ts`
- `server/routes/briefings.ts`
- `server/routes/daily-dashboard.ts`

DB・LLM・認証・永続化はすべて注入 or 別パッケージに委ね、本体は編成ロジックのみを収録しています。
