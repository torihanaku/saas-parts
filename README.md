# saas-parts

SaaS開発用の共有部品集（npm workspaces monorepo）。公開停止した自社プロダクト dev-dashboard（TS/TSX 約27.5万行）から、汎用性の高い実戦コードを抽出・脱結合したもの。**全37パッケージ・約980テストgreen**（バッチ1=18個、バッチ2=19個）。

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
| **─ バッチ2 ─** | | | |
| tenant-resolver | メール→tenant_id解決（キャッシュ/ドメインバックフィル/ガード） | node | 20 |
| tenant-secrets | テナント別暗号化シークレット保管庫（BYOK・AES-256-GCM） | node | 32 |
| agency-access | 代理店マルチクライアント委任（3層role・アクセス制御・監査） | node | 26 |
| stripe-billing | Stripe Webhook（署名検証/冪等性）＋Checkout/Portal | node | 25 |
| usage-quota | プラン別アクション日次クォータ（UTC 0時リセット） | node/edge | 29 |
| product-registry | 製品×プラン×Stripe Price×エンタイトルメントのレジストリ | node/edge | 18 |
| audit-log | SHA-256ハッシュチェーン付き監査ログ＋改ざん検証 | node | 19 |
| gdpr | GDPRカスケード削除＋残渣検証＋JSON/CSVエクスポート | node | 23 |
| consent | 目的ベース同意管理（キャッシュ/失効カスケード/法的根拠） | node/edge | 17 |
| email | Resend APIラッパー＋メールテンプレ（招待/トライアル/ドリップ） | node/edge | 15 |
| push-notifications | Web Push土台（購読検証/VAPID/注入式sender） | node/edge | 32 |
| reauth | 再認証トークン＋タイミング攻撃緩和（OTP/2FA可） | node | 18 |
| api-keys | 公開APIキー管理（SHA-256ハッシュ保存/スコープ/失効） | node/edge | 20 |
| resilience | リトライ+サーキットブレーカー+TTL付きLRU | any | 30 |
| logger | PIIマスキング構造化ログ+リクエストコンテキスト | node | 30 |
| validation | 入力バリデーション＋エラー封筒 | node/edge | 15 |
| transcribe-client | AssemblyAI話者分離書き起こしラッパー | node | 11 |
| storage-upload | Supabase Storageテナント分離アップロード | node/edge | 6 |
| browser-utils | BOM付きCSVダウンロード+日付フォーマッタ | browser | 12 |
| sql-templates | Postgresマイグレーション雛形8本（テナント/課金/監査/GDPR） | SQL | — |

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
