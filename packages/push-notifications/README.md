# @torihanaku/push-notifications

Web Push の土台レイヤー。ブラウザからの PushSubscription の検証・正規化、VAPID 設定の解決チェーン、配送実装（web-push 等）の注入バインディング、throw しない送信ラッパー、期限切れ購読（404/410）の判定を提供する。I/O フリーで `web-push` に依存しない。

## 主要API

```ts
import {
  validateSubscription,
  isKnownPushHost,
  isExpiredStatus,
  createPushService,
} from "@torihanaku/push-notifications";

// 1) ブラウザから届いた購読ペイロードの検証（endpoint URL形状 + p256dh/auth 必須）
const v = validateSubscription(reqBody.subscription);
if (!v.ok) return badRequest(v.error);
v.subscription; // { endpoint, p256dh, auth }（trim済み）

// 2) サービス生成（envは読まない。設定は全て注入）
const push = createPushService({
  vapidPublicKey: config.vapidPublicKey,
  vapidPrivateKey: config.vapidPrivateKey,
  vapidSubject: "ops@myapp.example",  // mailto:/https:// 以外は mailto: 前置
  appUrl: "https://myapp.example",    // subject未指定時のフォールバック
});
push.getPublicVapidKey();             // ブラウザの subscribe 用
push.getVapidConfig();                // キー未設定なら null（Foundationはキーなし運用可）

// 3) 配送実装の注入（web-push をハード依存させないための注入ポイント）
import webpush from "web-push";
push.setSender(async (sub, payload, vapid) => {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } },
    );
    return { ok: true };
  } catch (e: any) {
    return { ok: false, expired: isExpiredStatus(e?.statusCode ?? 0), error: String(e) };
  }
});

// 4) 送信（絶対にthrowしない。キー未設定=vapid_not_configured / 未注入=sender_not_bound）
const res = await push.sendNotification(v.subscription, { title: "件名", body: "本文", url: "/inbox" });
if (res.expired) await store.removeSubscription(v.subscription.endpoint); // 404/410 → 掃除
```

## 依存

なし（`web-push` はハード依存させず、`sender` として注入する設計）。

## 注入ポイント

- `vapidPublicKey` / `vapidPrivateKey` — 両方揃わない限り `getVapidConfig()` は null
- `vapidSubject` → `appUrl` → プレースホルダ `mailto:noreply@example.invalid` の解決チェーン（元実装の VAPID_SUBJECT → APP_URL → fallback と同じ、RFC 8292 準拠）
- `sender`（config または `setSender()`）— 実配送ライブラリのバインディング。元実装の `__setSenderForTests` を正式APIに昇格

## 想定ランタイム

Node 18+ / Bun / Edge（URL と Promise があればよい。I/O なし）。

## 出典

`dev-dashboard-v2/server/lib/push-notifications.ts`（テスト: `tests/push-notifications.test.ts` の lib 単体テスト部を移植。ルートハンドラ部はアプリ側の責務のため未移植）
