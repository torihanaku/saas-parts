# saas-parts — AI向け利用ガイド

SaaS開発用の共有部品monorepo。失敗プロダクト dev-dashboard（torihanaku/dev-dashboard）から抽出・脱結合した実戦コード。全部品はテスト付き・自己完結（パッケージ間import無し・process.env読み取り無し・依存はすべて注入式）。

## 使い方（コンテクスト消費を最小にする手順）

1. **この索引だけを読む**（全ファイル走査は不要）
2. 用途に合う部品を選び、その `packages/<name>/README.md` **だけ**を読む（用途/API例/注入ポイント/出典を記載）
3. 取り込みはどちらか:
   - `"@torihanaku/<name>": "file:../saas-parts/packages/<name>"` を依存に追加（同一マシン）
   - パッケージの `src/` を対象プロジェクトへコピー（vendoring。自己完結なのでそのまま動く）
4. 実装コードを読む必要があるのは改造時のみ

## 部品索引

### サーバー基盤
- **@torihanaku/auth-session** — HMAC署名＋AES-GCM暗号化のセッション/招待トークンとCookie/Bearerリクエスト認証（RBAC付き・resolver注入で外部依存ゼロ）（runtime: node, deps: なし）
- **@torihanaku/security-headers** — セキュリティヘッダー(CSP/HSTS等)・CORS許可リスト・CSRF Originチェックを純関数で提供（runtime: any ※Fetchアダプタのみ node18+/bun, deps: なし）
- **@torihanaku/oauth-manager** — プロバイダ非依存のOAuth 2.0認可コードフロー（PKCE S256・state CSRF・トークン交換/リフレッシュ・接続永続化を注入式ストアで提供）（runtime: node, deps: なし）
- **@torihanaku/saml-sp** — SAML 2.0 SPラッパー（アサーション検証・SPメタデータXML・NameID/属性抽出、設定は注入型）（runtime: node, deps: @node-saml/node-saml）
- **@torihanaku/rate-limiter** — 分散スライディングウィンドウのレートリミッター（ティア別上限・IPブロック/許可リスト・違反バックオフ・統計API、Redisクライアント注入＋インメモリフォールバック）（runtime: node|bun, deps: なし）
- **@torihanaku/http-helpers** — fetch標準のHTTPレスポンスヘルパー（gzip/ETag/ページネーション/タイムアウトfetch）（runtime: node, deps: なし）

### データ・状態
- **@torihanaku/cache** — 注入Redis＋メモリフォールバックのキャッシュ層（TTL/プレフィックス無効化/統計/分散レート制限）（runtime: any, deps: ioredis(optional)）
- **@torihanaku/persistence** — 注入DAL上のスコープ付き汎用CRUD層（ソフトデリート/updated_at/upsert/batchInsert）（runtime: any, deps: なし）
- **@torihanaku/supabase-dal** — テーブル非依存のSupabase RESTラッパー（CRUD/Storage/RPC/相関IDログ・全設定コンストラクタ注入）（runtime: any, deps: なし）
- **@torihanaku/feature-flags** — 環境変数トグル＋テナント別オーバーライド＋監査証跡つきフィーチャーフラグ判定（runtime: any, deps: なし）
- **@torihanaku/env-config** — zodベースのdefineEnv環境変数ハーネス（Fail-Fast検証/必須・任意分離/空文字正規化/型安全）（runtime: any, deps: zod）

### 非同期処理
- **@torihanaku/job-scheduler** — 名前付きジョブのインターバル実行スケジューラ（登録/tick/状態追跡/永続化注入/run-now/完了フック）（runtime: any, deps: なし）
- **@torihanaku/webhook-delivery** — 送信Webhookの署名付き配信エンジン（監査ログ・指数バックオフ再送、ストア注入式）（runtime: node, deps: なし）

### AI
- **@torihanaku/claude-api** — Anthropic Messages APIのraw-fetchラッパー（チャット/Tool Useループ/JSON出力/使用量フック/prompt caching）（runtime: any, deps: なし）
- **@torihanaku/embeddings** — マルチプロバイダ埋め込み抽象化（レジストリ/OpenAIプロバイダ/月次コストガードレール注入ストア方式）（runtime: any, deps: なし）

### フロントエンド
- **@torihanaku/api-client** — 認証トークン注入・タイムアウト・使用量上限フィードバックを一元化した型付きfetchラッパー（runtime: browser, deps: なし）
- **@torihanaku/react-hooks** — ビューポート判定・fetch・フォーカストラップ・フィーチャーフラグ・認証コンテキストの汎用Reactフック集（runtime: browser, deps: react）

### インフラ雛形
- **@torihanaku/infra-templates** — Bun+Cloud Run向けDockerfile/CI/pre-push/起動検証スクリプトの雛形集（runtime: template, deps: なし。`templates/` のファイルを `{{PLACEHOLDER}}` 置換してコピー）

## 組み合わせのヒント

- `supabase-dal` は `persistence` の `DalClient` インターフェースを構造的に満たす（import不要でそのまま渡せる）
- `cache` のクライアントは `rate-limiter` の `RateLimiterClient` と同じくioredis互換の構造的インターフェース
- `env-config` で検証したenvを各部品のconfigに渡すのが基本パターン（部品側はenvを読まない）

## 部品追加の規約

1. パッケージは自己完結（他の@torihanaku/*をimportしない。共有が必要なら最小インターフェースをローカル定義）
2. `process.env` 直読み禁止・secretの値をコード/テスト/READMEに書かない（キー名は可）
3. 構成: `package.json`（@torihanaku/<name>, type:module, exports→src/index.ts）/ `tsconfig.json`（../../tsconfig.base.json継承）/ `src/index.ts` / `src/*.test.ts` / `README.md`（用途1行・API例・注入ポイント・想定ランタイム・出典）
4. 検証: リポルートで `npx tsc --noEmit -p packages/<name>/tsconfig.json` と `npx vitest run packages/<name>` が通ること
5. 追加したらこのAGENTS.mdの索引に1行追記
