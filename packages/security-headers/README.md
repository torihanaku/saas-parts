# @torihanaku/security-headers

エンタープライズ向けセキュリティヘッダー（CSP / HSTS / X-Frame-Options 等）と CORS 許可リスト・CSRF Origin チェックを、フレームワーク非依存の純関数として提供するパッケージ。

## 主要API

すべて「設定オブジェクト + リクエスト事実（method / path / ヘッダー値）」を受け取り、ヘッダーのレコードや許可/拒否の判定を返す純関数です。フレームワーク（Hono 等）や `process.env` には依存しません。

```ts
import {
  securityHeadersFor,
  checkCsrfOrigin,
  evaluateCors,
  corsHeadersFor,
  corsPreflightHeadersFor,
  isCrossOriginProtocolPath,
  type SecurityConfig,
} from "@torihanaku/security-headers";

const config: SecurityConfig = {
  allowedOrigins: ["https://app.example.com"],
};

// 1) レスポンスに付けるセキュリティヘッダーを計算
const headers = securityHeadersFor(config, {
  path: "/api/v1/state",
  forwardedProto: req.headers.get("X-Forwarded-Proto"), // "https" のとき HSTS 付与
  requestId: "req-123",                                  // X-Request-Id / X-Correlation-Id
});
// => { "Content-Security-Policy": "...", "X-Frame-Options": "DENY", "X-API-Version": "1", ... }

// 2) CORS 許可リスト + CSRF Origin チェック（判定のみ）
const decision = checkCsrfOrigin(config, {
  method: "POST",
  path: "/api/state",
  origin: req.headers.get("Origin"),
  cookie: req.headers.get("Cookie"), // session クッキー検出に使用
});
// => { allowed: true } | { allowed: false, status: 403, reason: "origin-not-allowed" | "origin-required", message }

// 3) handleCors 相当のフル判定（403 / プリフライト204 / 素通し）
const result = evaluateCors(config, { method: "OPTIONS", path: "/api/test", origin: "..." });
// => { kind: "forbidden" | "preflight" | "pass", ... }

// 4) 通常レスポンス用の CORS ヘッダー（許可リスト外なら {}）
corsHeadersFor(config, { origin: "https://app.example.com" });
// => { "Access-Control-Allow-Origin": "...", "Access-Control-Allow-Credentials": "true" }
```

### Fetch API アダプタ（`Request` / `Response` を直接扱う薄いラッパー）

```ts
import { addSecurityHeaders, addCorsHeaders, handleCors } from "@torihanaku/security-headers";

// サーバーのハンドラ内（Bun.serve / Node の fetch ハンドラ / Hono の c.req.raw など）
const short = handleCors(config, request);      // Response(403/204) | null
if (short) return short;
let response = await next();
response = addCorsHeaders(config, response, request.headers.get("Origin") ?? "");
return addSecurityHeaders(config, response, request, requestId);
```

## 依存

なし（外部依存ゼロ）。`peerDependencies` もなし。テストのみ vitest（モノレポルートで管理）。

## 設定ポイント（何を注入するか）

`SecurityConfig` は全フィールド省略可。デフォルトは元プロジェクトのハードコード値を再現します。

| フィールド | 内容 | デフォルト（= 元プロジェクトの実値） |
|---|---|---|
| `allowedOrigins` | CORS で許可する Origin（完全一致） | `["http://localhost:5173"]`（元は env `CORS_ORIGIN` / `APP_URL` 由来。本番例: `"https://dev.folia.la"` のような自アプリ URL） |
| `callbackPathPrefixes` | Origin 許可リストを免除するプロトコル都合のコールバック（SAML ACS は IdP が自 Origin から POST するため） | `["/auth/saml/acs/", "/auth/google/callback", "/auth/sso/callback/"]` |
| `relaxedCspPathPrefixes` | 緩和 CSP（script-src に `'unsafe-inline'` 追加）を適用するパス | `["/login", "/auth/"]` |
| `defaultCsp` / `relaxedCsp` | CSP 文字列そのもの | 元プロジェクトのディレクティブそのまま（`connect-src` に `*.supabase.co` / Google OAuth 等） |
| `sessionCookieName` | CSRF Origin 必須チェックで検出するセッションクッキー名 | `"session"` |
| `apiVersionPathPrefix` / `apiVersion` | `X-API-Version` を付けるパスと値 | `"/api/v1"` / `"1"` |
| `corsAllowMethods` / `corsAllowHeaders` / `corsMaxAge` | プリフライト応答ヘッダー | `"GET, POST, PUT, PATCH, DELETE, OPTIONS"` / `"Content-Type, Authorization, X-E2E-Bypass"` / `"86400"` |

固定で出力されるヘッダー（元実装そのまま）: `X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: strict-origin-when-cross-origin` / `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()` / HSTS は `X-Forwarded-Proto: https` のときのみ `max-age=31536000; includeSubDomains`。

## 想定ランタイム

- コア（`security.ts`）: **any**（純関数のみ。ブラウザ / Node / Bun / Deno / Workers）
- アダプタ（`adapter.ts`）: Fetch API グローバル（`Request` / `Response` / `Headers`）がある環境（Node >= 18 / Bun / Deno / Workers）

## 出典

- 元実装: `実運用SaaS/server/middleware/security.ts`
- 元テスト: `実運用SaaS/tests/security-headers.test.ts`
