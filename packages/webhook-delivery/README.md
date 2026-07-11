# @torihanaku/webhook-delivery

## 用途

送信Webhookの配信エンジン。イベントに一致するエンドポイントへHMAC-SHA256署名付きでHTTP POSTし、試行ごとの監査ログを残す（指数バックオフの再送はオプトイン）。

## 主要API

```ts
import {
  WebhookDeliverer,
  type WebhookEndpoint,
  type DeliveryLogStore,
  type EndpointSource,
} from "@torihanaku/webhook-delivery";

// 永続化はインターフェース注入（未指定なら no-op / 空ソース）
const logStore: DeliveryLogStore = {
  async logDelivery(record) {
    await db.insert("webhook_deliveries", record); // 任意のDBへ
  },
};
const endpointSource: EndpointSource = {
  async listEnabledEndpoints(userId) {
    return db.select("webhook_endpoints", { user_id: userId, enabled: true });
  },
};

const deliverer = new WebhookDeliverer({ endpointSource, logStore });

// 1) ユーザーの一致エンドポイント全部へ fire-and-forget 配信（元 triggerWebhooks）
await deliverer.trigger("user-1", "content.created", { id: "abc" });

// 2) 単一エンドポイントへ1回配信＋監査ログ（元 deliverToEndpoint）
const endpoint: WebhookEndpoint = {
  id: "ep-1",
  user_id: "user-1",
  url: "https://example.com/webhook",
  secret: "whsec_...",
  events: ["content.created", "*"],
  enabled: true,
};
await deliverer.deliver(endpoint, "content.created", { id: "abc" });

// 3) プロセス内の指数バックオフ再送（2s→4s→8s…、初回＋最大5リトライ）
const result = await deliverer.deliverWithRetry(endpoint, "content.created", { id: "abc" });
// => { ok: boolean, attempts: number, lastStatusCode: number }
```

受信側検証用に `signPayload(body, secret)`（hex HMAC-SHA256）もエクスポートしています。署名は既定で `X-Folia-Signature` ヘッダーに載ります。

## 依存

- ランタイム依存なし（peerDependencies なし）。`node:crypto` の `createHmac` とグローバル `fetch` / `crypto.randomUUID` / `AbortSignal.timeout` を使用。
- テストのみ vitest（monorepo ルートに導入済み）。

## 設定ポイント（何を注入するか）

`new WebhookDeliverer(config)` の `config`（すべて任意）:

| キー | 既定値 | 説明 |
|---|---|---|
| `endpointSource` | 空ソース | `trigger()` が使うエンドポイント一覧の取得先（元は supabase の `dd_webhook_endpoints`） |
| `logStore` | no-op | 試行ごとの監査ログの書き込み先（元は supabase の `dd_webhook_deliveries`） |
| `timeoutMs` | `10000` | 1リクエストのタイムアウト |
| `signatureHeader` | `"X-Folia-Signature"` | 署名ヘッダー名 |
| `userAgent` | `"Folia-Webhook-Delivery/1.0"` | User-Agent |
| `maxResponseBodyLength` | `2000` | 監査ログに残すレスポンス本文の最大長 |
| `maxRetries` | `5` | `deliverWithRetry()` の最大リトライ回数（初回試行を除く） |
| `backoffBaseMs` | `2000` | バックオフ基準値。待機は `base * 2^(attempt-1)` = 2s→4s→8s… |
| `onError` | `console.error` | 内部で握りつぶすエラーの通知先 |

環境変数の直接読み取りはありません（すべてコンストラクタ注入）。シークレット値は各エンドポイントの `secret` として呼び出し側が渡します。

## 想定ランタイム

node（Node.js 18+ / Bun。`node:crypto`・グローバル `fetch` が必要。ブラウザ不可）

## 出典

- `dev-dashboard-v2/server/lib/webhook-delivery.ts`（本体）
- `dev-dashboard-v2/server/lib/webhook-signing.ts`（`signPayload` のみインライン）
- 参考: `dev-dashboard-v2/server/lib/job-scheduler.ts` の `webhookRetryHandler`（元プロジェクトの再送は外部cronで最大3試行。本パッケージではプロセス内 `deliverWithRetry()` として提供）
