# @torihanaku/notifications

アプリ内通知のフルスタック部品。サーバー側（フレームワーク非依存の Request→Response ハンドラ：一覧 / 未読数 / 作成 / 既読化 / ソフト削除 / SSE ストリーム）とクライアント側（React フック：履歴取得 + SSE 購読 + localStorage 設定 + 未読カウント / 既読化）を1パッケージで提供する。

移植元: 実運用SaaS `server/routes/notifications.ts`（246 LOC）+ `src/hooks/useNotifications.ts`（106 LOC）。

## サーバー側（React 非依存）

ストレージは `NotificationStore` として注入する（元実装は Supabase の `dashboard_notifications` テーブル直結だった）。認可は `authorize` 述語として注入する（元実装は `requireRole(req, "admin", "editor")`。`Response` を返せば拒否、`null` で許可）。

```ts
import {
  createNotificationsHandler,
  createInMemoryNotificationStore,
} from "@torihanaku/notifications";

const store = createInMemoryNotificationStore(); // 参照実装。本番はDB実装を注入
const handler = createNotificationsHandler({
  store,
  authorize: async (req) => (await isEditor(req)) ? null : new Response("forbidden", { status: 403 }),
  basePath: "/api/notifications",   // 既定値
  corsOrigin: "https://app.example", // SSEストリームのCORS（既定 "*"）
  // heartbeatIntervalMs: 30000, sseClients: 共有Map, log, now, generateId も注入可
});

// Bun.serve / fetchハンドラ内で:
const res = await handler(req);          // 該当パス以外は null
if (res) return res;
```

エンドポイント（`basePath` 相対）:

| Method | Path | 説明 |
|---|---|---|
| GET | `{base}` | 一覧（`?status=pending\|read\|all`・`?limit=`最大200） |
| GET | `{base}/count` | 未読数（バッジ用。失敗時は `{count: 0}` に退避） |
| POST | `{base}` | 作成（title必須≤500字 / message必須≤2000字 / type・target は不正値を既定値に正規化） |
| PATCH | `{base}/:id/read` | 既読化（UUID以外のIDは400） |
| DELETE | `{base}/:id` | ソフト削除（`status: "deleted"`。監査証跡のため物理削除しない） |
| GET | `{base}/stream` | SSE ハートビートストリーム（レガシー互換。元実装同様、認可ゲート対象外） |

`sseClients` Map を渡すと、ホストアプリ側から接続中クライアントへブロードキャストできる（元実装の `server/lib/state` 共有マップに相当）。

## クライアント側（React フック）

```tsx
import { useNotifications } from "@torihanaku/notifications";

function Bell() {
  const { notifications, unreadCount, markAsRead, markAllAsRead, preferences } =
    useNotifications({
      // すべて省略可。既定は fetch / EventSource ベース
      endpoints: {
        list: "/api/notifications",
        stream: "/api/notifications/stream",
        markRead: (id) => `/api/notifications/${id}/read`,
      },
      storageKey: "techradar-notification-prefs", // 通知設定のlocalStorageキー（元実装値）
      maxItems: 100,
      reconnectDelayMs: 5000,
    });
  // ...
}
```

- 履歴フェッチ（`T[]` / `{items}` / `{data}` 形式に対応）→ SSE 購読 → 切断時は5秒後に再接続。
- localStorage の設定（`enabled` / `types` 別のオン・オフ）で受信をフィルタ。
- `markAsRead` は楽観更新 + サーバー反映（失敗は握りつぶし。元実装と同じ）。
- `api`（`get`/`post`/`stream`）を丸ごと注入すれば認証ヘッダー付きクライアントや独自 SSE 実装に差し替え可能。

## 元実装との差分（注意点）

- **クライアントの既読化メソッド**: 元実装のクライアントは `POST {base}/:id/read`、元実装のサーバーは `PATCH` を期待していた（元リポでは別系統のAPIを向いていたための不整合）。本パッケージの既定 API は **PATCH** を送り、同梱サーバーとそのまま噛み合う。旧サーバーに接続する場合は `createDefaultNotificationsApi({ postMethod: "POST" })` を注入する。
- **通知の型**: サーバー側は `status`/`read_at`（DBスキーマ由来）、クライアント側は `read: boolean`/`user_id`（元のフロント型）。元実装をそのまま移植したため乖離が残る。サーバーレスポンスをフロント型へ写像する場合は `api.get` の注入でアダプトする。
- サーバーの Supabase 依存・`requireRole`・CORS 環境変数はすべて注入に置換。ロジック・バリデーション・エラーハンドリングは元実装のまま。

## peerDependencies

- `react >= 18`（optional。クライアントフックを使う場合のみ。`src/server/` は React を import しない）
