# @torihanaku/analytics-client

軽量なクライアント計測フック。ページビュー（`page_view`）・機能利用（`feature_use`）・セッション終了（`session_end`）の3種のイベントを送信する。セッション終了はページ離脱時（`beforeunload`）に `navigator.sendBeacon` でフラッシュするため、アンロード中でも取りこぼしにくい。計測は絶対にアプリを壊さない（送信失敗はすべて握りつぶす）。

移植元: 実運用SaaS `src/hooks/useAnalytics.ts`（113 LOC）。

## 使い方

```tsx
import { useAnalytics } from "@torihanaku/analytics-client";

function App({ currentPage }: { currentPage: string }) {
  const { trackFeatureUse } = useAnalytics(currentPage, {
    // すべて省略可
    endpoint: "/api/analytics",     // 既定値
    storageKey: "dd_anonymous_id",  // 匿名IDのlocalStorageキー（既定値）
    // transport: 独自トランスポート注入（下記）
  });

  return <button onClick={() => trackFeatureUse("export", { format: "csv" })}>CSV出力</button>;
}
```

## 送信されるイベント

すべてのイベントに `timestamp`（ISO 8601）と `user_id`（localStorage 永続の匿名UUID）が付与される:

| event_type | タイミング | 追加フィールド |
|---|---|---|
| `page_view` | `currentPage` が変わったとき（同一ページの再レンダーでは送らない） | `page` |
| `feature_use` | `trackFeatureUse(feature, metadata?)` 呼び出し時 | `page`, `metadata: { feature, ...metadata }` |
| `session_end` | `beforeunload`（sendBeacon 経由） | `metadata: { duration_seconds }` |

## トランスポート注入

既定は `fetch`（POST JSON）+ `navigator.sendBeacon`。認証付きクライアントやバッチ送信に差し替えられる:

```ts
import type { AnalyticsTransport } from "@torihanaku/analytics-client";

const transport: AnalyticsTransport = {
  post: (path, body) => authedApi.post(path, body),
  sendBeacon: (path, body) => navigator.sendBeacon(path, new Blob([JSON.stringify(body)], { type: "application/json" })),
};
```

サーバー側の集計レスポンス型（`AnalyticsReport` / `DailyActiveUsers` / `FeatureUsage` / `PageView` / `SessionDurationTrend`）も元実装からそのままエクスポートしている（ダッシュボード表示用の契約型）。

## 元実装との差分

- `session_end`（sendBeacon）にも `timestamp` / `user_id` を付与するようにした（元実装はイベント本体のみで、サーバー側の帰属が効かなかった）。
- 送信先・匿名IDキー・トランスポートを設定/注入化。それ以外のロジック（ページ変化検知・沈黙失敗・duration計算）は元実装のまま。

## peerDependencies

- `react >= 18`
