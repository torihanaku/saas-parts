# @torihanaku/stripe-billing

Stripe のサブスク課金機構（Webhook 処理・Checkout / Customer Portal セッション作成）をルートハンドラーから切り出した再利用ライブラリ。

## 主要API例

```ts
import Stripe from "stripe";
import {
  StripeWebhookProcessor,
  InMemoryWebhookEventStore,
  getPeriod,
  getCustomerEmail,
  createCheckoutSession,
  createPortalSession,
} from "@torihanaku/stripe-billing";

const stripe = new Stripe(secretKey); // SDK インスタンスは呼び出し側で生成して注入

// ── Webhook 処理（署名検証 → 冪等性チェック → イベントルーティング）
const processor = new StripeWebhookProcessor({
  stripe,
  webhookSecret,                              // Secret Manager 等から注入
  eventStore: new InMemoryWebhookEventStore(), // 本番は DB 実装を注入
})
  .on("checkout.session.completed", async (event) => {
    const obj = event.data.object as Record<string, unknown>;
    const meta = (obj.metadata as Record<string, string>) ?? {};
    // プラン更新などの副作用は呼び出し側のハンドラーで実施
    await upgradeUserPlan(meta.user_email, "pro");
  })
  .on("customer.subscription.updated", (event) => {
    // Stripe 2025+ API: period は Subscription Item 側にある場合も両対応
    const period = getPeriod(event.data.object as Record<string, unknown>);
  })
  .on("customer.subscription.deleted", async (event) => {
    const customerId = (event.data.object as { customer?: string }).customer;
    const email = customerId ? await getCustomerEmail(stripe, customerId) : null;
    if (email) await downgradeUserPlan(email, "free");
  });

// ルート側: ハンドラーが throw すると 400 を返し Stripe が自動リトライ
app.post("/api/billing/webhook", (req) => processor.handleRequest(req));

// ── Checkout セッション作成（トライアル日数は config で指定・env 読みなし）
const { url } = await createCheckoutSession(
  { stripe, successUrl, cancelUrl, trialDays: 14 },
  { email, priceId, metadata: { product_key: "cos", plan_key: "pro" } },
);

// ── Customer Portal（顧客が存在しない場合は null — 404 変換は呼び出し側）
const portal = await createPortalSession(stripe, { email, returnUrl });
```

## 依存
- peerDependencies: `stripe`（SDK インスタンスをコンストラクタ/引数で注入）
- ランタイム依存なし（fetch API の `Request`/`Response` のみ使用）

## 注入ポイント
- `stripe`: Stripe SDK インスタンス（シングルトン管理は呼び出し側）
- `webhookSecret`: Webhook 署名シークレット（env 直読みしない）
- `eventStore`: `WebhookEventStore`（冪等性ストア。元実装の supabase `stripe_webhook_events` テーブルを置換。省略時は冪等性チェックなし＝元実装の DB 未設定時と同じ挙動）
- `handlers` / `.on()`: イベント種別ごとのコールバック（元実装のプラン更新・トライアル終了メール等の副作用はここへ）
- `onError`: ハンドラー失敗時のログ出力先（デフォルト console.error）

## 想定ランタイム
Node.js 18+ / Bun / Cloud Run 等（fetch API 標準の環境）

## 出典
`dev-dashboard-v2/server/routes/billing.ts`（handleBillingWebhook / handleBillingCheckout / handleBillingPortal、約335行のうちルート・認証・supabase 結合を除いた Stripe 機構部分）
