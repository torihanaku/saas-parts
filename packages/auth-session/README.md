# @torihanaku/auth-session

## 用途（1行）
HMAC-SHA256署名＋AES-256-GCM暗号化のセッション/招待トークン発行・検証と、Cookie/Bearerベースのリクエスト認証（RBAC付き）を提供する自己完結ライブラリ。

## 主要API（コード例）

```ts
import { createAuthService, type SessionStore } from "@torihanaku/auth-session";

const auth = createAuthService({
  // 必須。環境変数（例: SESSION_SECRET）は呼び出し側で読んで渡す
  secret: mySessionSecret,
  cookieName: "session",          // 省略可（デフォルト "session"）
  sessionTtlMs: 7 * 24 * 3600e3,  // 省略可（デフォルト7日）
  adminEmail: "owner@example.com",// 省略可（requireSuperAdmin 用）

  // 任意注入ポイント（下記「設定ポイント」参照）
  sessionStore,     // サーバー側セッション永続化（UUIDトークン化）
  bearerResolver,   // Bearer トークン → email 解決（旧 Supabase JWT 検証）
  roleResolver,     // email → ロール解決（旧 dashboard_team_members 参照＋自動insert）
  isBypassRequest,  // E2E テスト用の認証バイパス判定
});

// ログイン成功時: トークン発行 + Set-Cookie
const token = await auth.createSessionCookie("user@example.com");
res.headers.set("Set-Cookie", auth.formatSessionCookie(token));

// リクエスト認証（標準 Request を受ける。フレームワーク非依存）
// checkAuth は getSessionEmail と同じ判定（セッションストアも参照）。失効・ストア障害は false
if (!(await auth.checkAuth(req))) return new Response("Unauthorized", { status: 401 });
const email = await auth.getSessionEmail(req);

// 現在のユーザー（未認証・失効・ストア障害・身元の無いトークンでは null。admin にはならない）
const me = await auth.getCurrentUserRole(req); // { email, role } | null
if (!me) return new Response("Unauthorized", { status: 401 });

// RBAC（未認証は 401、権限不足は 403、通過なら null）
const denied = await auth.requireRole(req, "editor"); // admin は自動で通過（階層あり）
if (denied) return denied;
const notSuper = await auth.requireSuperAdmin(req);

// 招待トークン（自己完結・HMAC署名・7日期限）
const invite = auth.createInviteToken("invite@example.com", "editor");
const payload = auth.verifyInviteToken(invite); // 期限切れ/改ざんは null

// 低レベル: トークンだけ使いたい場合
import { createTokenService, timingSafeEqualStr, getSecureOrigin } from "@torihanaku/auth-session";
const tokens = createTokenService({ secret: mySessionSecret });
const t = tokens.signToken("auth:user@example.com:1999999999999");
tokens.verifyToken(t); // タイミングセーフ比較
```

## 認証できないときの挙動（fail-closed）
次のどれでも「未認証」として扱い、**管理者（admin）にはしない**:
- Cookie も Bearer も無い
- サーバー側セッションが失効している（`sessionStore.getSession` が `null`、または `expiresAt` が過去）
- セッションストアが例外を投げた（障害）
- 署名は正しいが身元（email）を持たないトークン（レガシー `auth:{expires}`、ストアの無いサービスに来た `session:{uuid}:{expires}`）

| API | 未認証のとき |
|---|---|
| `getSessionEmail(req)` | `null` |
| `getCurrentUserRole(req)` | `null`（戻り値の型は `Promise<{ email: string; role: Role } \| null>`） |
| `requireRole(req, ...roles)` | `401` `{ "error": "認証が必要です" }`（権限不足は従来どおり `403`） |
| `checkAuth(req)` | `false`（`Boolean(await getSessionEmail(req))` と同じ。呼ぶたびにストアを1回読む） |

`"admin"` センチネル（`isBypassRequest` が true のリクエスト、引数なしの `createSessionCookie()` = fallbackIdentity）は従来どおり `{ email: "admin", role: "admin" }` になる。**`"admin"` という email を外部の ID プロバイダ（`bearerResolver` 等）から返さないこと**（返すと管理者として扱われる）。

### audit-log に渡すとき
`@torihanaku/audit-log` の `AuditContext.getCurrentUserRole` は `Promise<{ email; role }>`（null 不可）を要求する。そのまま渡すと型エラーになるので、未認証を明示的に扱うラッパーを挟む:

```ts
import { createAuditLogger } from "@torihanaku/audit-log";

const audit = createAuditLogger({
  store, // AuditStore（audit-log の README 参照）
  context: {
    async getCurrentUserRole(req) {
      const me = await auth.getCurrentUserRole(req);
      // 未認証を admin にしない。記録したくなければ例外にしてもよい
      return me ?? { email: "anonymous", role: "anonymous" };
    },
    getTenantId,
  },
});
```

## 破壊的変更（SA-0002 修正）
以前のバージョンからの移行時に確認すること:
1. **`getCurrentUserRole` の戻り値に `null` が入る。** 以前は未認証でも `{ email: "admin", role: "admin" }` を返していた（＝未ログインが管理者扱い）。分割代入 `const { role } = await auth.getCurrentUserRole(req)` は null チェックが必要。audit-log の `AuditContext` に直接渡していた場合は上のラッパーに置き換える。
2. **`requireRole` は未認証で `401` を返す。** 以前は未認証のリクエストが admin として素通りしていた。
3. **`checkAuth` はセッションストアを見る。** 以前はトークンの署名と期限だけで true を返していたため、失効済みセッションも通っていた。今は呼ぶたびに `sessionStore.getSession` を1回呼び、ストアが落ちていると `false` を返す。
4. 「未認証なら admin」に戻すオプトインは用意しない。

トークン形式（移植元と完全互換）:
- 署名付きトークン: `encrypt(data) + "." + HMAC-SHA256(encrypt(data))先頭32hex`
- 暗号化データ: `ivHex:authTagHex:ciphertextHex`（AES-256-GCM、鍵は secret から HMAC 導出）
- データ内容: `session:{uuid}:{expires}` / `auth:{email}:{expires}` / `auth:{expires}`（レガシー）

## 依存
なし（`node:crypto` と WHATWG `Request`/`Response` のみ。peerDependencies なし）。

## 設定ポイント（何を注入するか）
| 注入 | 型 | 役割 | 移植元での実装 |
|---|---|---|---|
| `secret` | `string`（必須・空不可） | HMAC/暗号鍵の素 | `env.SESSION_SECRET` の直接読み |
| `sessionStore` | `SessionStore` | UUIDセッションの保存/参照。`createSession` が `false`/throw なら email-in-token にフォールバック | Supabase `sessions` テーブルへの PostgREST fetch |
| `bearerResolver` | `(token) => Promise<string \| null>` | Bearer トークン → email。結果は5分・最大1000件の内部キャッシュで保持（元実装と同じ） | Supabase `GET /auth/v1/user` |
| `roleResolver` | `(email) => Promise<string \| null>` | email → ロール。新規ユーザーの自動insertは resolver 側の責務。null/不正値/例外は `adminEmail` 判定にフォールバック | `dashboard_team_members` lookup + 自動 insert |
| `isBypassRequest` | `(req) => boolean` | テスト/E2E用の認証バイパス（識別は "admin" 扱い） | `e2e-bypass.ts`（env ゲート付きヘッダー判定） |
| `logger` | `(entry) => void` | 構造化warning出力（デフォルト無音） | `console.warn(JSON.stringify(...))` |

ライブラリ内では process.env を一切読まない。環境変数（SESSION_SECRET / ADMIN_EMAIL 等）は合成ルートで読んで config として渡すこと。

## 想定ランタイム
node（Node 18+ / Bun 両対応。`node:crypto`・`Buffer`・グローバル `Request`/`Response` を使用）

## 出典（元ファイルパス）
- `実運用SaaS/server/lib/auth.ts`
- `実運用SaaS/server/lib/token.ts`
- テスト: `実運用SaaS/tests/server-auth.test.ts`, `tests/token.test.ts`
- 参照のみ: `server/lib/tenant.ts`（マルチテナント解決は製品固有のため移植せず。セッション/トークン機構は tenant に依存していないことを確認済み）

## 移植時に落としたもの（製品固有 wiring）
- `getUserIdUuid` / `getAuthUserUuid` — Supabase Admin API（listUsers）と `dashboard_team_members` に強結合のため未移植（元テストも無し）
- `requireAuth`（Hono ミドルウェア）— Hono Context ＋ Supabase メタデータ enrichment のため未移植（元テストも無し）
- テナント解決（`getTenantId` ほか tenant.ts 全体）— 製品マルチテナンシーのため未移植
- 元テストのうち drop/改変したケース:
  - 「getOrCreateMember auto-inserts new member（POST ボディ検証）」→ insert は roleResolver 側の責務になったため、resolver が null を返した際の "member" フォールバック検証に置換
  - 「verifySupabaseToken returns null when SUPABASE_URL is not set」→ 「resolver 未設定時に null」に置換（同じ意味論）
  - Supabase fetch モック群 → resolver モックに置換（アサーション内容は維持）
  - 非決定的だった ADMIN_EMAIL 依存の2テスト（admin ロール付与 / requireSuperAdmin）→ `adminEmail` 注入により決定的なテストに強化
