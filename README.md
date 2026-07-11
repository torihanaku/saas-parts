# saas-parts

SaaS開発用の共有部品集（npm workspaces monorepo）。公開停止した自社プロダクト dev-dashboard（TS/TSX 約27.5万行）から、汎用性の高い実戦コードを抽出・脱結合したもの。**全18パッケージ・584テストgreen**。

- 抽出元: `torihanaku/dev-dashboard`（ローカル: `~/torihanaku/dev-dashboard-v2`、読み取りのみ・無変更）
- 位置づけ: 「SaaS Foundation Kit」（設計基準 A-1〜A-13）の実装コード集
- 設計原則: 各パッケージは自己完結・依存注入式（`process.env` 直読みなし、DB/Redis等は最小インターフェースで注入、既定値=元実装の値）

## パッケージ一覧

| パッケージ | 用途 | runtime | テスト |
|---|---|---|---|
| auth-session | HMAC署名+AES-GCMのセッション/招待トークン、Cookie/Bearer認証、RBAC | node | 80 |
| security-headers | CSP/HSTS等ヘッダー・CORS許可リスト・CSRF Originチェック | any | 41 |
| oauth-manager | OAuth 2.0認可コードフロー（PKCE/state CSRF/リフレッシュ） | node | 52 |
| saml-sp | SAML 2.0 SP（アサーション検証/メタデータXML） | node | 30 |
| rate-limiter | スライディングウィンドウ・レートリミッター（ティア/IPリスト/統計） | node\|bun | 32 |
| http-helpers | gzip/ETag/ページネーション/タイムアウトfetch | node | 21 |
| cache | Redis注入+メモリフォールバックのキャッシュ層 | any | 44 |
| persistence | 注入DAL上の汎用CRUD `PersistenceLayer<T>` | any | 25 |
| supabase-dal | テーブル非依存のSupabase RESTラッパー | any | 34 |
| feature-flags | envトグル+テナント別オーバーライド+監査つきフラグ判定 | any | 41 |
| env-config | zodベース `defineEnv` 環境変数ハーネス | any | 16 |
| job-scheduler | 名前付きジョブのインターバル実行スケジューラ | any | 32 |
| webhook-delivery | 署名付きWebhook配信（監査ログ/バックオフ再送） | node | 14 |
| claude-api | Anthropic Messages APIラッパー（Tool Use/使用量フック） | any | 32 |
| embeddings | マルチプロバイダ埋め込み抽象化+コストガードレール | any | 50 |
| api-client | フロント用の型付きfetchラッパー（トークン注入/上限FB） | browser | 18 |
| react-hooks | useIsMobile/useFetch/useFocusTrap/フラグ/AuthContext | browser | 22 |
| infra-templates | Dockerfile/CI/pre-push/検証スクリプト雛形（Bun+Cloud Run） | template | — |

詳細（API例・注入ポイント・出典）は各 `packages/<name>/README.md`。AIエージェント向けの索引と利用手順は [AGENTS.md](./AGENTS.md)。

## 使い方

npm公開はしない。取り込みは以下のいずれか:

```jsonc
// 1) 同一マシンで file: 参照（推奨）
// 利用側 package.json
"dependencies": {
  "@torihanaku/rate-limiter": "file:../saas-parts/packages/rate-limiter"
}
```

```bash
# 2) bun link
cd ~/torihanaku/saas-parts/packages/rate-limiter && bun link
cd <利用プロジェクト> && bun link @torihanaku/rate-limiter
```

3) `src/` を丸ごとコピー（vendoring）— 各パッケージは自己完結なのでコピーでも動く

将来、複数マシン運用になったら GitHub Packages（private・@torihanaku スコープ）への公開に切り替える。

## 開発

```bash
bun install
npx tsc --noEmit        # 全体typecheck
npx vitest run          # 全テスト
# 単一パッケージ
npx tsc --noEmit -p packages/<name>/tsconfig.json
npx vitest run packages/<name>
```

## 収録見送り（意図的に抽出しなかったもの）

- ルートハンドラ60本超・ページコンポーネント461枚・ドメイン固有hooks・DBマイグレーション165本（製品固有）
- embeddings の類似検索（pgvector RPCに密結合。必要になったら注入式で別途切り出す）
- UI見た目コンポーネント（Kit標準はshadcn/ui。TremorベースのUIは流儀が衝突するため不採用）
- context-builder / report-scheduler（プロンプト構造の発想は有用だがデータ形状が製品固有。パターンとして参照するなら元リポの `server/lib/context-builder.ts` / `report-scheduler.ts`）
