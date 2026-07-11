# @torihanaku/push-client

Web Push のブラウザ側ライフサイクルを扱う React フック。通知許可プロンプト → ServiceWorker 登録の参照 → `PushManager.subscribe`（VAPID公開鍵）→ サーバーへの購読永続化、および解除（`unsubscribe` + サーバー側ミラー削除）までを `{ supported, status, error, enable, disable }` の安定した状態機械として提供する。

移植元: dev-dashboard-v2 `src/hooks/usePushSubscription.ts`（155 LOC・#345 PWA Push Notifications Foundation）。

## サーバー側との対

サーバー側は **`@torihanaku/push-notifications`**（VAPID設定の解決・購読ペイロード検証・配送注入・期限切れ購読の掃除）と対になる設計（相互 import はしない）。本パッケージが叩くエンドポイント契約:

| Method | Path（既定） | 契約 |
|---|---|---|
| GET | `/api/push/public-key` | → `{ "publicKey": string }`（URL-safe base64 の VAPID 公開鍵。`push-notifications` の `getPublicVapidKey()` をそのまま返せばよい） |
| POST | `/api/push/subscribe` | ← `{ "subscription": PushSubscriptionJSON, "userAgent": string }`（`push-notifications` の `validateSubscription()` で検証して永続化） |
| DELETE | `/api/push/unsubscribe` | ← `{ "endpoint": string }`（該当購読を削除） |

## 使い方

```tsx
import { usePushSubscription, PUSH_STRINGS_EN } from "@torihanaku/push-client";

function PushNotificationButton() {
  const { supported, status, error, enable, disable } = usePushSubscription({
    // すべて省略可
    endpoints: {
      publicKey: "/api/push/public-key",   // 既定値
      subscribe: "/api/push/subscribe",    // 既定値
      unsubscribe: "/api/push/unsubscribe" // 既定値
    },
    fetcher: authedFetch,          // 認証ヘッダー付き fetch を注入可
    // getPublicKey: async () => VAPID_PUBLIC_KEY, // 鍵の取得自体も差し替え可（ビルド時埋め込み等）
    strings: PUSH_STRINGS_EN,      // 既定は日本語（元実装の ja ロケール値）
  });

  if (!supported) return null;
  // status: "loading" | "unsupported" | "denied" | "idle" | "subscribing"
  //       | "subscribed" | "unsubscribing" | "error"
}
```

## 状態遷移（元実装準拠）

- マウント時: 非対応ブラウザ → `unsupported` / 許可ブロック済み → `denied` / 既存購読あり → `subscribed` / なし → `idle`（SW 参照失敗も `idle` に退避）。
- `enable()`: `subscribing` → 許可拒否なら `denied`（+ `strings.denied`）→ 鍵取得・subscribe・永続化のいずれか失敗で `error`（メッセージ、空なら `strings.errorGeneric`）→ 成功で `subscribed`。
- `disable()`: `unsubscribing` → サーバー側 DELETE → ブラウザ側 `unsubscribe()` → `idle`。購読がなければ何もせず `idle`。

## i18n

元実装は react-i18next の `t("push.denied")` / `t("push.errorGeneric")` を使っていた。本パッケージは `strings` 設定に置き換え、既定値は元プロジェクトの ja ロケール値（`PUSH_STRINGS_JA`）。`PUSH_STRINGS_EN` も同梱。i18n ライブラリと併用する場合は `strings: { denied: t("push.denied"), errorGeneric: t("push.errorGeneric") }` を渡す。

## その他のエクスポート

- `urlBase64ToUint8Array(base64)` — VAPID 公開鍵を `applicationServerKey` 用の fresh ArrayBuffer 裏付き `Uint8Array` に変換（SharedArrayBuffer 混入を防ぐ元実装のワークアラウンド込み）。
- `isBrowserSupported()` — serviceWorker / PushManager / Notification の存在チェック。

## peerDependencies

- `react >= 18`
