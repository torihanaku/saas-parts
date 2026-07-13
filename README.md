# saas-parts

SaaS開発でよく必要になる「配管」を、実運用SaaSから抽出・脱結合した **自己完結・依存注入式・テスト付き** のTypeScript部品集です（bun / npm workspaces monorepo）。**全112パッケージ＝汎用96＋機能キット10＋テンプレート6・約3,443テストgreen**。

認証・課金(Stripe)・マルチテナント/RLS・監査ログ・GDPR・レート制限・Webhook配信 … といった「作るのは面倒だが、間違えると事故になる20%」を、そのまま使える形で提供します。

- **自己完結**: 各パッケージは他の `@torihanaku/*` に依存しない（必要なら最小インターフェースをローカル定義）
- **依存注入式**: `process.env` を直読みしない。DB / Redis / LLM 等は最小インターフェースで注入する
- **テスト付き**: 全パッケージに vitest テスト。CI・RLS分離テスト・秘密スキャン・SAST・CodeQL が常時稼働（下記「安全なコード管理」）

> 出自について: 本コードは実運用していた社内SaaSから、どのSaaSでも使える汎用メカニズムだけを抽出・一般化したものです。製品固有の業務ロジックは含みません。

## 安全なコード管理（CI / セキュリティ）

2026-07-13 の全数セキュリティ監査（確定バグ43件を修正・8PR）を受けて、**「テストgreen≠正しい」を継続的に守る仕組み**を導入。捕まえる穴の種類が違うツールを重ねている。

| 仕組み | 何を守る | 実行 | 状態 |
|---|---|---|---|
| **CI**（`.github/workflows/ci.yml`） | 全パッケージの型チェック＋全テスト（毎PR） | 自動・ブロッキング | 常時 |
| **RLS分離テスト**（`rls-test.yml` / `bun run test:rls`） | テナント越境SELECT/INSERT/UPDATEを実Postgresで検証 | 自動・ブロッキング | 常時 |
| **プロパティテスト**（fast-check・`*.property.test.ts`） | 退化入力(空/0/巨大/マルチバイト/重複)で不変条件が壊れないか | `bun run test` に同梱 | 常時 |
| **秘密スキャン**（gitleaks） | secretの混入 | 自動・ブロッキング | 常時 |
| **SAST**（Semgrep） | 注入/XSS/SSRF | 自動・可視化（棚卸し後ゲート化） | 常時 |
| **依存脆弱性**（Dependabot） | 既知脆弱性のある依存 | 週次PR＋アラート | 常時 |
| **ミューテーションテスト**（Stryker・`bun run mutation`） | 「テストが実はバグを検知できていない」穴 | 週次＋手動 | パイロット |
| **CodeQL**（`codeql.yml`） | データフロー/taint解析→Security タブ | 自動（毎PR＋週次） | 常時 |

- 本リポは **public**。CodeQL の code scanning（Security タブ）が無料で有効。結果は GitHub の Security タブに集約される。
- **Stryker** はこのリポの `typescript@7`(native) 環境向けに `stryker.config.mjs` で tsconfig前処理を回避済み。`MUTATE='packages/<name>/src/**/*.ts' bun run mutation` で対象を広げられる。
- 新しい部品を足すときの観点は [AGENTS.md](./AGENTS.md) のセキュリティ・チェックリストと、グローバルの `~/.claude/rules/vibe-coding-pitfalls.md`（頻出5類型）を参照。

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
| transcript-parser | 字幕VTT/SRT/plain→話者付き素テキスト変換 | any | 19 |
| storage-upload | Supabase Storageテナント分離アップロード | node/edge | 6 |
| browser-utils | BOM付きCSVダウンロード+日付フォーマッタ | browser | 12 |
| sql-templates | Postgresマイグレーション雛形8本（テナント/課金/監査/GDPR） | SQL | — |
| **─ バッチ3: アルゴリズム ─** | | | |
| bm25 | BM25ランキング | any | 17 |
| thompson-bandit | ThompsonサンプリングA/B割当 | any | 16 |
| stats-sim | モンテカルロ+MMM弾力性抽出 | any | 21 |
| sql-generator | 自然言語→SQL+SELECT限定バリデータ | any | 26 |
| anomaly-detection | 閾値異常検出器+監視オーケストレータ | any | 32 |
| **─ バッチ3: セキュリティ/運用 ─** | | | |
| security-utils | Webhook署名/SSRF対策URL検証/安全path/PIIハッシュ | node/edge | 42 |
| rls-jwt | RLS段階ロールアウト用テナントJWT | node | 22 |
| canary-rollout | 決定的ハッシュ段階ロールアウト | any | 7 |
| deployment-snapshot | デプロイ前スナップショット+ロールバック記録 | any | 5 |
| audit-archive | 監査イベントJSONLコールドアーカイブ | any | 7 |
| config-management | 設定カタログ+外部サービスヘルスチェック | node/edge | 51 |
| **─ バッチ3: ビジネス ─** | | | |
| okr-service | OKR CRUD+自動進捗更新 | any | 20 |
| lead-scorer | 3軸リードスコアリング+MQL判定 | any | 13 |
| benchmark-aggregator | k-匿名業界ベンチマーク集計 | node | 24 |
| template-marketplace | テンプレ市場（匿名化/投稿/クローン/レビュー） | node | 51 |
| customer-intelligence | 顧客プロファイル+チャーン/購買意欲 | any | 17 |
| widget-store | ダッシュボード/ウィジェット永続化 | node/edge | 32 |
| bigquery-admin | テナント別暗号化BQ認証情報+クエリ実行 | node | 20 |
| **─ バッチ3: 通信/フロント ─** | | | |
| slack-harness | Slackユーザー解決+Block Kit構築/DM | node/edge | 22 |
| channel-summarizer | マルチチャネル統合LLM要約 | any | 16 |
| email-decision-parser | メール返信から承認/却下抽出 | any | 14 |
| image-gen | マルチプロバイダAI画像生成 | node/bun | 24 |
| notifications | アプリ内通知フルスタック（server+client） | any/browser | 22 |
| command-palette | コマンドパレットclient | browser | 20 |
| live-state | polling+SSE状態同期フック | browser | 9 |
| analytics-client | 計測フック（sendBeacon対応） | browser | 10 |
| push-client | Web Push購読ライフサイクルフック | browser | 13 |
| **─ バッチ3: 機能キット ─** | | | |
| kit-approval-workflow | 承認ワークフロー（申請→リスク評価→Slack承認→監査+稟議+エスカレーション） | node/bun | 66 |
| kit-causal-inference | 因果推論エンジン（DID/PSM/RDD/MMM/変化点/反実仮想/WhatIf 12手法） | any | 119 |
| kit-ai-agent | AIエージェント基盤（計画→承認→実行→ロールバック+MCP雛形） | node/bun | 60 |
| kit-decision-memory | 意思決定ログ/why検索/組織記憶/オンボーディングAI | node/bun | 75 |
| **─ バッチ4 ─** | | | |
| custom-domains | BYODカスタムドメイン（CNAME検証+SSLプロビジョニング） | node/bun | 33 |
| compliance-jp | 日本広告規制チェック（薬機法/景表法/特商法 50ルール） | any | 118 |
| eval-harness | LLM評価（ゴールデンケース+P/R/F1+リグレッション比較） | any | 28 |
| attribution-algos | アトリビューション（Markov/Shapley/first/last/linear） | any | 8 |
| ab-significance | A/Bベイズ勝者判定（信用区間非重なり） | any | 16 |
| forecast-engines | 時系列予測（移動平均/ARIMA近似/季節回帰+自動選択） | any | 16 |
| kit-pattern-dna | 組織パターンDNA学習・判定（文体/成功要因/反応予測） | node/browser | 107 |
| kit-chief-of-staff | AI経営アシスタント（ingest→digest→ブリーフィング→Q&A→タスク） | node/bun | 89 |
| kit-research-navigator | 調査アシスタント（シグナル取込→仮説カード→学び記録） | node/bun | 68 |
| kit-integration-manager | 外部SaaS統合マネージャー（Provider契約+Nango実装） | any | 68 |
| **─ バッチ5: キット ─** | | | |
| kit-ai-workforce | 「AI社員」チーム編成・稼働（状態機械+SSE/BM25/キャラCRUD。書籍2冊同梱） | node+React | 42 |
| kit-devops-metrics | DORA4指標+デプロイ運用（健全性/タイムライン/昇格制御） | node/bun | 86 |
| **─ バッチ5: 業務機能 ─** | | | |
| hiring | 採用（求人票/応募者トラッキング/公開応募/GDPR削除） | node | 36 |
| documents | 文書CRUD+テンプレAI生成 | node | 18 |
| transcripts-manager | 書き起こし管理/アクション抽出/音声メタ | node | 27 |
| skills-service | スキルCRUD+AI推薦 | node | 21 |
| setup-wizard | 初期セットアップ段階ガイド | node | 43 |
| saas-inventory | SaaS利用棚卸し（検出/コスト/重複検知） | node | 10 |
| white-label-branding | テナント別ブランディング設定+パートナー管理 | node | 24 |
| daily-briefing | 毎朝AIブリーフィング編成 | node | 17 |
| slack-reports | 定期レポートBlock Kit組立4種+registry | node | 12 |
| **─ バッチ5: 意思決定・実験 ─** | | | |
| bias-detector | 認知バイアス6種のAI検知 | node/browser | 39 |
| ab-testing-service | 実験ライフサイクル（起票→AI生成→勝者判定） | node/browser | 29 |
| scenario-twin | 施策シナリオのデジタルツイン | node/browser | 37 |
| memory-connectors | Notion/Slack意思決定抽出+埋め込みコスト管理 | node | 31 |
| **─ バッチ5: マーケ・ドメイン ─** | | | |
| ad-budget-optimizer | 広告予算最適化・再配分・入札変更・ROI予測 | node | 58 |
| cpa-guardrail | CPA閾値監視→広告停止提案 | node | 7 |
| analytics-normalizer | GA4/GSC/Ads異種メトリクス統一正規化 | node | 25 |
| ai-visibility-monitor | AI検索でのブランド言及監視 | node | 11 |
| brand-lint | 表現lint+却下事例ルール自動進化 | node | 32 |
| content-generation | ペルソナ別生成/多変量/原子化/リミックス | node | 70 |
| challenger-copy | Safe/Edgy 2案生成+フィードバック学習 | node | 27 |
| press-media | プレスリリース生成/記者CRM/配信タイミング | node | 52 |
| abm | アカウント階層化/エンゲージ/戦略生成 | node | 17 |
| brand-crisis-monitor | SNS炎上監視/感情分類/スパイク検知 | node | 17 |
| legal-first-opinion | 法務文書AIファーストオピニオン | node | 9 |
| autonomous-deploy | 承認→段階実行→タイムラインの自律デプロイ | node | 23 |
| asset-debt-scanner | 資産劣化巡回スキャン→修繕提案（7スキャナ） | node | 20 |
| **─ バッチ5: テンプレート ─** | | | |
| eval-lab-py | LLM評価実験ラボ（FastAPI+SQLite・Python） | template | — |
| openapi-pipeline | client/server型共有パイプライン | template | — |
| locale-starter | SaaS汎用UI文言の日英対訳スターター | template | — |
| ops-playbooks | Sentry/E2E/AI-PR運用ランブック集 | template | — |

詳細（API例・注入ポイント・出典）は各 `packages/<name>/README.md`。AIエージェント向けの索引と利用手順は [AGENTS.md](./AGENTS.md)。

## インストール / 取り込み

現状 npm レジストリには公開していません。各パッケージは自己完結なので、以下のいずれかで取り込みます。

```bash
# 1) vendoring（最も簡単・推奨）: 必要なパッケージの src/ を丸ごとコピー
#    自己完結なのでコピーだけで動く。改造も自由。
cp -r saas-parts/packages/rate-limiter/src your-app/src/lib/rate-limiter
```

```jsonc
// 2) 同一マシンで file: 参照（利用側 package.json）
"dependencies": {
  "@torihanaku/rate-limiter": "file:../saas-parts/packages/rate-limiter"
}
```

```bash
# 3) bun link
cd saas-parts/packages/rate-limiter && bun link
cd <利用プロジェクト> && bun link @torihanaku/rate-limiter
```

## 使い方の例

依存注入式なので、DB や Redis などは呼び出し側で渡します。

```ts
import { createTokenService } from "@torihanaku/auth-session";

// secret はあなたの composition root（env 検証後）から注入する
const tokens = createTokenService({ secret: process.env.SESSION_SECRET! });

const cookie = await tokens.createSessionCookie("user@example.com");
const payload = tokens.verifySessionToken(cookie); // 署名＋有効期限を検証
```

```ts
import { validateWebhookUrl, headCheck } from "@torihanaku/security-utils";

// SSRF 安全に外部 Webhook URL を検証（DNS 解決先の private IP も遮断）
if (validateWebhookUrl(url) === null) {
  const reachable = await headCheck(url);
}
```

各パッケージの詳しい API・注入ポイントは `packages/<name>/README.md` を参照。

## 開発

```bash
bun install
bun run test        # 全パッケージのテスト
bun run typecheck   # 型チェック
bun run test:rls    # RLS テナント分離テスト（要ローカル Postgres）
bun run mutation    # ミューテーションテスト（中核パッケージ）
```

新しい部品を足すときの規約とセキュリティ・チェックリストは [AGENTS.md](./AGENTS.md) を参照。

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
