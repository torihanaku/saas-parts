# @torihanaku/logger

## 用途

PII 自動マスキング付きの構造化 JSON ロガー（GCP severity 形式）＋ AsyncLocalStorage ベースのリクエストコンテキスト伝搬。

## 主要 API

```ts
import {
  logError, logWarn, logInfo, sanitize,
  setErrorSink,
  runWithRequestContext, getRequestContext, getRequestId, requestContext,
} from "@torihanaku/logger";

// 構造化ログ（message は必ず sanitize される）
logInfo("billing.webhook", "received event for user@example.com");
// → {"severity":"INFO","context":"billing.webhook","message":"received event for [EMAIL]"}
logWarn("auth", "token=abcdefgh12345678 expired");   // → token=[REDACTED]
logError("db", new Error("user 550e8400-... denied")); // → [UUID]

// エラーシンク注入（元実装の Sentry.captureException 相当）
setErrorSink((error, { context }) => {
  Sentry.captureException(error, { extra: { context } });
});

// リクエストコンテキスト（HTTP ミドルウェア等で束ねる）
app.use((req, res, next) => {
  runWithRequestContext({ requestId: req.headers["x-request-id"], userId: req.user?.id }, next);
});
// 以降の async サブツリー全体で:
getRequestId();       // コンテキスト内なら束ねた ID、外なら新規 UUID を生成
getRequestContext();  // { requestId, userId?, startTime } | undefined
// ログ行にも requestId が自動付与される:
// {"severity":"INFO","context":"...","message":"...","requestId":"req-123"}
```

### マスキングされるパターン（元実装の正規表現をそのまま維持）

| パターン | 置換 |
|---|---|
| メールアドレス | `[EMAIL]` |
| `Bearer/token/secret/apiKey/api_key/password/session` に続く 8 文字以上の値 | `$1=[REDACTED]` |
| UUID (v4 形式) | `[UUID]` |

## 依存

なし（`node:async_hooks` と `crypto.randomUUID` のみ）。

## 注入ポイント

- `setErrorSink(sink)` — `logError` から呼ばれる外部エラー通報先。元実装は `process.env.SENTRY_DSN` が設定されているときに `@sentry/node` の `captureException(error, { extra: { context } })` を呼んでいた。本パッケージは env 読み取りと Sentry 依存を外し、コールバック注入に置き換え（未注入ならコンソール出力のみ）
- `runWithRequestContext(partialCtx, fn)` — requestId/userId/startTime を欠けた分はデフォルト補完（新規 UUID / `Date.now()`）して束ねる
- `requestContext`（生の `AsyncLocalStorage`）も export しているため低レベル統合も可能

## 想定ランタイム

Node.js 19+ / Bun（`node:async_hooks` とグローバル `crypto.randomUUID` が必要。ブラウザ不可）。

## 出典

`dev-dashboard-v2/server/lib/logger.ts` ＋ `server/lib/context.ts`（テストは `tests/logger.test.ts` から移植・拡張）。

### 元実装から変えた点

- Sentry 直接 import ＋ `SENTRY_DSN` 環境変数ゲート → `setErrorSink()` によるコールバック注入
- ログ行への `requestId` 自動付与を追加（元実装では logger と context は未接続だった）
- `sanitize` を export（元実装はモジュール内 private）
