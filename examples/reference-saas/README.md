# reference-saas — 部品を配線した最小の動くSaaS

saas-parts の部品を「実際にどう組むか」を示す、最小構成のリファレンス実装です。
**認証・テナント分離・監査ログ・レート制限・セキュリティヘッダ**を1つのHTTPアプリに配線し、
結合テストで「配線した結果としてそれらが本当に効いている」ことを検証します。

## 配線している部品

| 部品 | 役割 | このアプリでの使いどころ |
|---|---|---|
| [`auth-session`](../../packages/auth-session) | セッションCookie（HMAC署名＋期限検証） | `POST /login` で発行、以降のリクエストで検証 |
| [`security-headers`](../../packages/security-headers) | CSP/HSTS 等のヘッダ | 全レスポンスに付与 |
| [`rate-limiter`](../../packages/rate-limiter) | IP×ティア別レート制限 | `/login` は auth ティア(30/min) |
| [`tenant-resolver`](../../packages/tenant-resolver) | email → tenant_id 解決 | 認証後にテナントを特定 |
| [`audit-log`](../../packages/audit-log) | 改ざん検知ハッシュチェーン | widget 作成を記録・検証 |

## エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/login` | email でセッションCookieを発行（デモのためパスワード無し） |
| GET | `/widgets` | 自テナントの widget 一覧（**他テナントのものは見えない**） |
| POST | `/widgets` | widget 作成 → 監査ログに記録 |
| GET | `/audit/verify` | 監査ログのハッシュチェーンを検証（改ざん検知） |

## 設計のポイント

- **composition root で注入**（[`src/app.ts`](./src/app.ts)）: secret やストアはすべて `createApp()` で組み立てて注入。部品側は `process.env` を読まない。
- **全ハンドラが `(Request) => Response` の純関数**: ポートを開かずにテストできる（[`src/app.test.ts`](./src/app.test.ts)）。`src/server.ts` が `Bun.serve` で公開するだけ。
- **テナントスコープはアプリ層で必ず通す**: `WidgetStore` の read/write は tenant_id でフィルタ。ここを外すとクロステナント漏洩になる。

## 実行

```bash
bun install
bun run --cwd examples/reference-saas start   # http://localhost:3000
# テスト
bunx vitest run examples/reference-saas
```

```bash
# 動作例
curl -i -c cookies.txt -X POST localhost:3000/login -d '{"email":"alice@acme.com"}'
curl -b cookies.txt -X POST localhost:3000/widgets -d '{"name":"hello"}'
curl -b cookies.txt localhost:3000/widgets
curl -b cookies.txt localhost:3000/audit/verify
```

## 本番に持っていくには

このデモはインメモリのストアを注入していますが、**同じ配線のまま**実装だけ差し替えます。

1. **テナント分離を DB 層に効かせる**: `WidgetStore` を Postgres 実装にし、[`sql-templates`](../../packages/sql-templates) の RLS ポリシー（`USING` ＋ `WITH CHECK`）＋ [`rls-jwt`](../../packages/rls-jwt) でテナントJWTを発行する。アプリ層のスコープと DB 層の RLS の二重で守る。
2. **セッション永続化**: `auth-session` の `SessionStore` を注入してサーバー側失効を可能にする。
3. **秘密の管理**: `secret` を env から（[`env-config`](../../packages/env-config) で検証して）注入。
4. **課金を足す**: [`stripe-billing`](../../packages/stripe-billing) の `StripeWebhookProcessor` を `/billing/webhook` に、`createCheckoutSession` を `/billing/checkout` に配線。

> このアプリは「部品はこう組む」を示す教材です。実運用では上記の差し替えに加え、各部品の README にある注入ポイントとセキュリティ観点（[AGENTS.md](../../AGENTS.md)）を確認してください。
