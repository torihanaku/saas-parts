# @torihanaku/oauth-manager

プロバイダ非依存の OAuth 2.0 認可コードフロー（PKCE S256・state CSRF 対策・トークン交換/リフレッシュ・接続の永続化）を提供する汎用マネージャ。

## 主要API

```ts
import { OAuthManager, type OAuthProviderConfig } from "@torihanaku/oauth-manager";

const config: OAuthProviderConfig = {
  authorizationUrl: "https://provider.example.com/oauth/authorize",
  tokenUrl: "https://provider.example.com/oauth/token",
  clientId: "...",        // 呼び出し側が注入（例: 自アプリの env 層で GITHUB_CLIENT_ID 等を読む）
  clientSecret: "...",
  scope: "read write",
  extraAuthParams: { access_type: "offline" }, // 任意
  usePkce: true,          // 任意: PKCE (S256) を有効化
};

const manager = new OAuthManager("github", config);

// 1) 認可URLを生成（CSRF-safe な state 付き。usePkce 時は code_challenge も付与）
const { url, state } = await manager.buildAuthUrl("https://app.example.com/callback");
// …ユーザーを url にリダイレクト…

// 2) コールバックで state を検証しつつコード→トークン交換（PKCE の code_verifier は自動送出）
const token = await manager.exchangeCode(code, returnedState, "https://app.example.com/callback");

// 3) リフレッシュ
const renewed = await manager.refreshToken(token.refresh_token!);

// 4) 接続の永続化（保存/更新/失効/一覧/取得）
const conn = await manager.saveConnection("user-1", token);
await manager.updateConnection(conn.id, renewed);
await manager.revokeConnection(conn.id);
const list = await manager.listConnections("user-1");
```

プリセットのファクトリ（エンドポイント・スコープ定義済み。認証情報は呼び出し側が渡す）:

```ts
import { createSlackOAuthManager, createGitHubOAuthManager } from "@torihanaku/oauth-manager";

const slack = createSlackOAuthManager({ clientId, clientSecret }); // 未設定なら null
const github = createGitHubOAuthManager({ clientId, clientSecret });
```

state 単体のユーティリティ（`generateOAuthState` / `verifyOAuthState` / `consumeOAuthState`）と PKCE 生成（`generatePkce`）も個別に export しています。

## 依存

なし（`node:crypto` と global `fetch` のみ。peerDependencies なし）。

## 設定ポイント（何を注入するか）

- **プロバイダ設定** (`OAuthProviderConfig`): 認可/トークンエンドポイント・clientId/clientSecret・scope・追加クエリ・PKCE 有効化。**このパッケージ内では process.env を一切読みません。** 環境変数（例: `SLACK_CLIENT_ID`）は呼び出し側で読み、config として渡してください。
- **redirect URI**: `buildAuthUrl` / `exchangeCode` の引数として毎回渡す。
- `OAuthManagerOptions`（すべて任意・省略時はインメモリ既定）:
  - `stateStore: StateStore` — state ノンス保存（get/set/del + TTL）。既定はプロセス内メモリ。マルチインスタンス構成では Redis 等の実装を注入（ノンスは10分TTL・ワンタイム。ストアミス時は type-only 検証にフォールバック）。
  - `connectionStore: ConnectionStore` — 接続の永続化（insert/patch/get、PostgREST 互換の `key=eq.value` フィルタ文字列）。Supabase REST を薄くラップするだけで本番実装になる形。既定は `InMemoryConnectionStore`。
  - `table: string` — 保存先テーブル名（既定 `oauth_connections`）。
  - `fetch` — fetch 実装の差し替え（テスト用）。トークンリクエストは 15 秒でタイムアウト。

## 想定ランタイム

node（`node:crypto` の `createHash`/`randomBytes` を使用。Bun でも動作）。

## 出典

失敗SaaSプロジェクトからの移植:

- `/Users/nakanomanabu/torihanaku/dev-dashboard-v2/server/lib/oauth-manager.ts`
- `/Users/nakanomanabu/torihanaku/dev-dashboard-v2/server/lib/oauth-state.ts`（本パッケージに吸収。Redis キャッシュ層依存 → 注入式 `StateStore` に置換）

移植時の変更点: Supabase ヘルパー → 注入式 `ConnectionStore`、`fetchWithTimeout` ヘルパー → 内蔵化、ファクトリの env 読み → 呼び出し側から認証情報を注入、PKCE (S256) をオプトインで追加。
