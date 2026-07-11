# @torihanaku/reauth

機微操作（キー削除・課金変更など）の直前に「もう一度本人確認」を挟むための re-auth トークン基盤。32byte hex トークン＋15分TTLのインメモリ store（自動掃除つき）と、タイミング攻撃緩和（80〜120msランダム遅延）つきの資格情報再検証フローを提供する。

## 主要API

```ts
import { createReauthStore, createReauthFlow } from "@torihanaku/reauth";

// 1) トークンstore（インメモリ・15分TTL・60秒ごと自動掃除）
const store = createReauthStore(); // { ttlMs, cleanupIntervalMs, tokenBytes, headerName, now } を注入可

// 2) 再検証フロー（実際の照合は注入コールバック。元実装はSupabaseのpassword grantだった）
const flow = createReauthFlow({
  store,
  verifyCredentials: async (email, password) => {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST", headers, body: JSON.stringify({ email, password }),
    });
    return res.ok;
  },
});

// 2a) 低レベルAPI: 遅延→検証→トークン発行
const result = await flow.verifyAndIssueToken(email, password);
// { ok: true, token } | { ok: false }

// 2b) 元ルートの移植: POST body { password } → { reauth_token }（401/400を返し分け）
const handler = flow.createVerifySessionHandler(getSessionEmail);
// routes: if (pathname === "/api/auth/verify-session") return handler(req);

// 3) 機微操作側のガード: ヘッダー X-Reauth-Token を検証。不備なら403 Response、通過ならnull
const denied = await store.requireReAuth(req, sessionEmail);
if (denied) return denied;

// テスト・シャットダウン時
store.dispose();
```

## 依存

なし（`node:crypto` の randomBytes のみ）。

## 注入ポイント

- `verifyCredentials(email, credential)` — 実際の照合ロジック。パスワードに限らず **OTPコードや2FAチャレンジの検証にもそのまま使える**（credential の意味は呼び出し側が定義。汎用の step-up 認証フロー）
- `store` オプション — `ttlMs`（既定15分）/ `cleanupIntervalMs`（既定60秒、`null`でタイマー無効）/ `tokenBytes`（既定32）/ `headerName`（既定 `X-Reauth-Token`）/ `now`
- `flow` オプション — `minDelayMs`（既定80）/ `jitterMs`（既定40）/ `sleep` / `random`（テスト用）
- `createVerifySessionHandler(getSessionEmail)` — セッション解決の注入

## 注意

- store はインメモリのためプロセス単位。複数インスタンス構成では sticky session か外部storeへの置き換えが必要
- ランダム遅延は成功/失敗どちらのパスでも先に挟まれる（元実装どおり）

## 想定ランタイム

Node 18+ / Bun（`Response.json` と `node:crypto` を使用）。

## 出典

`dev-dashboard-v2/server/lib/reauth-token.ts` ＋ `server/routes/auth/reauth.ts`（テスト: `tests/reauth-flow.test.ts` を移植・拡張）
