# saas-parts — AI向け利用ガイド

SaaS開発用の共有部品monorepo（全112パッケージ＝汎用部品96＋機能キット10＋テンプレート6）。失敗プロダクト dev-dashboard（torihanaku/dev-dashboard）から**全数抽出完了**した実戦コード（3体エージェントの最終総ざらいで取りこぼしゼロを確認済み）。全部品はテスト付き・自己完結（パッケージ間import無し・process.env読み取り無し・依存はすべて注入式）。約3,300テストgreen。

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
- **@torihanaku/api-keys** — 公開APIキー管理（生成/SHA-256ハッシュ保存/認証/スコープ/期限/失効、Store注入）（runtime: Node18+/Bun/Edge, deps: なし）
- **@torihanaku/reauth** — 再認証トークン（15分TTL）＋タイミング攻撃緩和つき資格情報再検証（OTP/2FA可）（runtime: Node18+/Bun, deps: なし）
- **@torihanaku/validation** — リクエスト入力バリデーション＋400/500エラー封筒（runtime: node/edge, deps: なし）
- **@torihanaku/security-utils** — Webhook署名(HMAC)/SSRF対策URL検証/パストラバーサル安全join/PIIハッシュ/Kintone署名検証（runtime: node/edge, deps: なし）
- **@torihanaku/rls-jwt** — Postgres RLS段階ロールアウト用テナントJWTミント＋canaryシャドー比較（runtime: node, deps: なし）

### アルゴリズム・統計
- **@torihanaku/bm25** — BM25スコアリング・習熟度重み付きランキング（runtime: any, deps: なし）
- **@torihanaku/thompson-bandit** — ThompsonサンプリングによるA/Bバリアント割当・勝者事後確率（runtime: any, deps: なし）
- **@torihanaku/stats-sim** — モンテカルロ分布シミュレーション＋MMM弾力性テーブル抽出・因果オーバーライド（runtime: any, deps: なし）
- **@torihanaku/sql-generator** — 自然言語→BigQuery SQL生成＋SELECT限定安全バリデータ（runtime: any, deps: なし／LLMとDWHは注入）
- **@torihanaku/anomaly-detection** — ローリングベースライン閾値検出器(スパイク/配信失敗/順位下落)＋テナント走査監視オーケストレータ（runtime: any, deps: なし）
- **@torihanaku/attribution-algos** — マルチタッチアトリビューション（Markov除去効果/Shapley/first・last・linear）（runtime: any, deps: なし）
- **@torihanaku/ab-significance** — A/Bテストのベイズ勝者判定（Beta事後の信用区間非重なり）（runtime: any, deps: なし）
- **@torihanaku/forecast-engines** — 日次時系列予測（移動平均/ARIMA近似/季節回帰＋自動選択）（runtime: any, deps: なし）
- **@torihanaku/eval-harness** — LLM評価ハーネス：ゴールデンケースランナー+precision/recall/F1+リグレッション比較（runtime: any, deps: なし）

### テナント・組織管理
- **@torihanaku/custom-domains** — BYODカスタムドメインのCNAME検証+SSLプロビジョニング状態機械（runtime: Node/Bun, deps: なし）
- **@torihanaku/compliance-jp** — 日本の広告規制（薬機法/景表法/特商法）50ルール同梱テキストコンプラチェック＋LLM代替表現提案（runtime: any, deps: なし）
- **@torihanaku/tenant-resolver** — メール→tenant_id解決（デフォルトテナントキャッシュ・ドメインバックフィル・requireTenant/requireUserガード）（runtime: Node18+/Bun, deps: なし）
- **@torihanaku/tenant-secrets** — テナント別暗号化シークレット保管庫（BYOK・AES-256-GCM・envフォールバック・プロバイダping）（runtime: Node18+/Bun, deps: node:crypto）
- **@torihanaku/agency-access** — 代理店マルチクライアント委任（3層role・アクセス制御ミドルウェア・拒否監査・招待status自動補正）（runtime: Node18+/Bun, deps: なし）

### 課金・プラン
- **@torihanaku/stripe-billing** — Stripe Webhook処理（署名検証/冪等性/イベントルーティング）＋Checkout/Portalセッション作成（runtime: Node18+/Bun, deps: stripe(peer)）
- **@torihanaku/usage-quota** — プラン別アクション日次クォータ（UTC 0時リセット・403ペイロード互換）（runtime: Node18+/Bun/Edge, deps: なし）
- **@torihanaku/product-registry** — プロダクト×プラン×Stripe Price環境変数×エンタイトルメントの中央レジストリ＋起動時DB同期（runtime: Node18+/Bun/Edge, deps: なし）

### コンプライアンス
- **@torihanaku/audit-log** — SHA-256ハッシュチェーン付き監査ログ（記録＋改ざん検証）（runtime: Node 18+/Bun, deps: なし）
- **@torihanaku/audit-archive** — 監査イベントのJSONLコールドアーカイブ（ObjectStorage注入・スケジューラ非依存）（runtime: any, deps: なし）
- **@torihanaku/gdpr** — GDPRカスケード削除＋残渣検証＋JSON/CSVエクスポート（runtime: Node 18+/Bun, deps: なし）
- **@torihanaku/consent** — 目的ベース同意チェック（60秒キャッシュ・失効カスケード・法的根拠）（runtime: Node 18+/Bun/Edge, deps: なし）

### 通信
- **@torihanaku/email** — Resend APIラッパー＋日本語メールテンプレート（招待/トライアル終了/ドリップ）（runtime: Node18+/Bun/Edge, deps: なし）
- **@torihanaku/push-notifications** — Web Push土台（購読検証/VAPID解決/注入式sender/期限切れ判定）（runtime: Node18+/Bun/Edge, deps: なし）
- **@torihanaku/notifications** — アプリ内通知フルスタック（server: 注入Store+認可のCRUD/SSEハンドラ, client: useNotifications）（runtime: server=any/client=browser, deps: react(client)）
- **@torihanaku/slack-harness** — SlackユーザーID⇔アプリユーザー解決(1hキャッシュ)＋承認Block Kit構築/DM送信(copy注入)（runtime: node/edge, deps: なし）
- **@torihanaku/channel-summarizer** — マルチチャネル統合LLM要約（200字サマリ＋actionItems、LLM/BYOK注入）（runtime: any, deps: なし）
- **@torihanaku/email-decision-parser** — メール返信から承認/却下＋理由を抽出（日英キーワード設定可・ヘッドレス承認用）（runtime: any, deps: なし）

### 信頼性・可観測性・運用
- **@torihanaku/resilience** — リトライ(指数バックオフ+ジッター)・サーキットブレーカー・TTL付きLRUキャッシュ（runtime: any, deps: なし）
- **@torihanaku/logger** — PIIマスキング付き構造化JSONログ+AsyncLocalStorageリクエストコンテキスト（runtime: Node 19+/Bun, deps: なし）
- **@torihanaku/canary-rollout** — 決定的ハッシュによるテナント別段階ロールアウト判定（状態共有不要・単調拡大）（runtime: any, deps: なし）
- **@torihanaku/deployment-snapshot** — デプロイ前スナップショット取得＋ロールバック監査記録の汎用契約（store全注入）（runtime: any, deps: なし）
- **@torihanaku/config-management** — 設定変数カタログ(検証/マスク/.envテンプレ生成)＋外部サービスヘルスチェック(組み込み8種プラガブル)（runtime: node/edge, deps: なし）

### ビジネスサービス
- **@torihanaku/okr-service** — OKRのCRUD・進捗計算・データソース連動の自動進捗更新（runtime: any, deps: なし）
- **@torihanaku/lead-scorer** — 行動+適合度+エンゲージメントの3軸リードスコアリング・MQL判定・次元別内訳（runtime: any, deps: なし）
- **@torihanaku/benchmark-aggregator** — 業界ベンチマーク集計（k-匿名性ガード+オプトイン同意+テナントID匿名化）（runtime: node, deps: なし）
- **@torihanaku/template-marketplace** — テンプレのマーケットプレイス（パターン匿名化・投稿/クローン/レビュー・LLM抽出コア）（runtime: node, deps: なし）
- **@torihanaku/customer-intelligence** — 統合顧客プロファイル構築＋チャーンリスク・購買意欲分析（LLM注入/ヒューリスティックfallback）（runtime: any, deps: なし）
- **@torihanaku/widget-store** — dashboard/widget/favoriteのCRUD永続化（daily upsert・shot履歴・pin順favorites、ドライバ注入）（runtime: node/edge, deps: なし）
- **@torihanaku/bigquery-admin** — テナント別暗号化BigQuery認証情報の保存/解決/クエリ実行(SDK非依存・store注入)（runtime: node, deps: なし）

### データ・状態
- **@torihanaku/cache** — 注入Redis＋メモリフォールバックのキャッシュ層（TTL/プレフィックス無効化/統計/分散レート制限）（runtime: any, deps: ioredis(optional)）
- **@torihanaku/persistence** — 注入DAL上のスコープ付き汎用CRUD層（ソフトデリート/updated_at/upsert/batchInsert）（runtime: any, deps: なし）
- **@torihanaku/supabase-dal** — テーブル非依存のSupabase RESTラッパー（CRUD/Storage/RPC/相関IDログ・全設定コンストラクタ注入）（runtime: any, deps: なし）
- **@torihanaku/feature-flags** — 環境変数トグル＋テナント別オーバーライド＋監査証跡つきフィーチャーフラグ判定（runtime: any, deps: なし）
- **@torihanaku/env-config** — zodベースのdefineEnv環境変数ハーネス（Fail-Fast検証/必須・任意分離/空文字正規化/型安全）（runtime: any, deps: zod）

### 非同期処理
- **@torihanaku/job-scheduler** — 名前付きジョブのインターバル実行スケジューラ（登録/tick/状態追跡/永続化注入/run-now/完了フック）（runtime: any, deps: なし）
- **@torihanaku/webhook-delivery** — 送信Webhookの署名付き配信エンジン（監査ログ・指数バックオフ再送、ストア注入式）（runtime: node, deps: なし）

### AI・メディア
- **@torihanaku/claude-api** — Anthropic Messages APIのraw-fetchラッパー（チャット/Tool Useループ/JSON出力/使用量フック/prompt caching）（runtime: any, deps: なし）
- **@torihanaku/embeddings** — マルチプロバイダ埋め込み抽象化（レジストリ/OpenAIプロバイダ/月次コストガードレール注入ストア方式）（runtime: any, deps: なし）
- **@torihanaku/transcribe-client** — AssemblyAI話者分離書き起こし（ポーリング+バックオフ+10分タイムアウト）（runtime: node, deps: なし）
- **@torihanaku/transcript-parser** — VTT/SRT/プレーンテキストを話者ラベル付き素テキストに変換（Zoom/Otter/Tactiq対応・依存ゼロ）（runtime: any, deps: なし）
- **@torihanaku/storage-upload** — Supabase Storageテナント分離アップロード+画像MIME許可リスト（runtime: node/edge, deps: なし）
- **@torihanaku/image-gen** — マルチプロバイダAI画像生成（OpenAI/fal.aiルーティング・モデル5分キャッシュ・ImageSink注入・BYOK対応）（runtime: node/bun, deps: なし）

### フロントエンド
- **@torihanaku/api-client** — 認証トークン注入・タイムアウト・使用量上限フィードバックを一元化した型付きfetchラッパー（runtime: browser, deps: なし）
- **@torihanaku/react-hooks** — ビューポート判定・fetch・フォーカストラップ・フィーチャーフラグ・認証コンテキストの汎用Reactフック集（runtime: browser, deps: react）
- **@torihanaku/browser-utils** — BOM付きCSVダウンロード+日付フォーマッタ(ロケール可変)（runtime: browser, deps: なし）
- **@torihanaku/command-palette** — コマンドパレットclient（useCommands+ルール注入型classifier）（runtime: browser, deps: react）
- **@torihanaku/live-state** — polling+SSEハイブリッド状態同期フック（useLiveState）（runtime: browser, deps: react）
- **@torihanaku/analytics-client** — page/feature/session計測フック（useAnalytics・sendBeacon対応・transport注入）（runtime: browser, deps: react）
- **@torihanaku/push-client** — Web Push購読ライフサイクルフック（push-notificationsと対）（runtime: browser, deps: react）

### 機能キット（機能丸ごとの大型部品。コアはDI化済み・ルート層はアダプタ例）
- **@torihanaku/kit-approval-workflow** — 申請→リスク評価→承認→監査の承認ワークフロー汎用コア（稟議・Slack承認・複数承認者and/or集約・タイムアウトエスカレーション付き）（runtime: Node 20+/Bun, deps: なし）
- **@torihanaku/kit-causal-inference** — 因果推論エンジン(DID/PSM/RDD/FuzzyRDD/IK帯域/BOCD変化点/MMM/反実仮想/ショック検出/検定力/MAPE/WhatIf・純関数)（runtime: any, deps: なし）
- **@torihanaku/kit-ai-agent** — AIエージェント基盤（計画→承認ゲート→実行→ロールバック＋監視/自動切戻し/コスト/レポート＋MCPサーバー雛形＋**マルチエージェント協調エンジン(複数役割が順に作業→統合)＋協調チームプリセット**）（runtime: node/bun, deps: なし・LlmCaller/Store注入）
- **@torihanaku/kit-decision-memory** — 意思決定ログ/why検索/組織記憶/オンボーディングAI/引き継ぎ生成（LLM・埋め込み・ストア全注入、BM25フォールバック内蔵）（runtime: node/bun, deps: なし）
- **@torihanaku/kit-pattern-dna** — 組織パターンDNA学習・判定（良い例/悪い例取り込み→文体・成功要因・顧客反応の学習→下書き照合アラート→反応予測）（runtime: node/browser, deps: react(client hooksのみ)）
- **@torihanaku/kit-chief-of-staff** — AI経営アシスタント（Slack/メール/会議ingest→digest→ブリーフィング→Q&A→タスク抽出/人間レビュー/外部同期。ソース/LLM/同期先全注入）（runtime: node/bun, deps: react(client hooksのみ)）
- **@torihanaku/kit-research-navigator** — 調査アシスタント（外部シグナル取込→LLM verdict判定→トレンドクラスタ昇格→仮説カード生成→学び記録。ソース/LLM/トラッカー全注入）（runtime: node/bun, deps: なし）
- **@torihanaku/kit-integration-manager** — 外部SaaS統合マネージャー（接続管理/fire-and-wait同期/正規化レジストリ/マルチ発行/ヘルス。IntegrationProvider契約+Nango実装注入式）（runtime: any, deps: なし）
- **@torihanaku/kit-ai-workforce** — 「AI社員」チーム編成・稼働の中核（状態機械＋SSE／BM25で**得意分野タスクマッチング**／キャラCRUD／ロールモデル／テンプレート／チームコンポーザー／**タスク割当→評価→スキル自動昇格→CV記録の成長ループ**。docs/に製品コンセプト本2冊同梱）（runtime: node+React, deps: react(client)）
- **@torihanaku/kit-devops-metrics** — DORA4指標＋デプロイ運用（健全性/タイムライン/オーケストレーション/昇格制御。GitProvider・store・通知を注入、DORA計算式verbatim）（runtime: node/bun, deps: react(client)）

### 業務機能（そのまま小さなSaaSになる粒度・バッチ5）
- **@torihanaku/hiring** — 採用機能一式（求人票CRUD・応募者トラッキング・公開応募・GDPR削除）（runtime: node, deps: なし）
- **@torihanaku/documents** — 文書CRUD＋テンプレからのAI生成（runtime: node, deps: なし）
- **@torihanaku/transcripts-manager** — 書き起こし管理・アクション抽出・音声メタ管理（runtime: node, deps: なし）
- **@torihanaku/skills-service** — スキルCRUD＋AI推薦（runtime: node, deps: なし）
- **@torihanaku/setup-wizard** — 初期セットアップの段階的ガイド（runtime: node, deps: なし）
- **@torihanaku/saas-inventory** — 組織のSaaS利用棚卸し（検出/コスト集計/重複検知）（runtime: node, deps: なし）
- **@torihanaku/white-label-branding** — テナント別ブランディング設定CRUD＋パートナー関係管理（runtime: node, deps: なし）
- **@torihanaku/daily-briefing** — 毎朝のAIブリーフィング編成（ウィジェット収集→LLM要約→パーソナライズ構成）（runtime: node, deps: なし）
- **@torihanaku/slack-reports** — 定期レポートのBlock Kit組み立て4種＋registry（provider/sender/文言注入）（runtime: node, deps: なし）

### 意思決定・実験の運用層（バッチ5）
- **@torihanaku/bias-detector** — 意思決定文から認知バイアス6種をAI検知（BiasRegistry拡張可・LLM注入）（runtime: node/browser, deps: react(client)）
- **@torihanaku/ab-testing-service** — 実験ライフサイクル（起票→バリアントAI生成→計測→勝者判定→終了）（runtime: node/browser, deps: react(client)）
- **@torihanaku/scenario-twin** — 施策シナリオのデジタルツイン（ベースライン/シミュレーション/比較/感度/バックテスト・TwinMath注入）（runtime: node/browser, deps: react(client)）
- **@torihanaku/memory-connectors** — Notion/Slack意思決定抽出＋ハンドオフ配信＋埋め込みコスト管理（kit-decision-memoryのSourceExtractor契約に一致）（runtime: node, deps: なし）

### マーケティング・ドメイン（バッチ5・マーケSaaS向け）
- **@torihanaku/ad-budget-optimizer** — 広告予算の最適化提案・リアルタイム再配分・入札変更・ROI予測（AdPlatformAdapter注入）（runtime: node, deps: なし）
- **@torihanaku/cpa-guardrail** — CPA閾値監視→広告一時停止の提案生成（人手承認前提）（runtime: node, deps: なし）
- **@torihanaku/analytics-normalizer** — GA4/GSC/Google Ads/Meta等の異種メトリクス統一正規化＋集計/ROI/トレンド（runtime: node, deps: なし）
- **@torihanaku/ai-visibility-monitor** — ChatGPT/Perplexity/Geminiでのブランド言及サンプリング監視（EngineCaller注入）（runtime: node, deps: なし）
- **@torihanaku/brand-lint** — 表現lint（禁止語/トーン/類似度）＋却下事例からのルール自動進化（embedding/LLM注入）（runtime: node, deps: なし）
- **@torihanaku/content-generation** — ペルソナ別コンテンツ生成・コピー多変量・長文→SNS原子化・実績リミックス（LLM注入）（runtime: node, deps: なし）
- **@torihanaku/challenger-copy** — Safe/Edgy 2案コピー生成→提示→選択フィードバック学習ループ（LintCheck述語注入）（runtime: node, deps: なし）
- **@torihanaku/press-media** — プレスリリース生成（4類型）・記者CRM（関係スコア/ピッチ生成）・PR配信タイミング提案（runtime: node, deps: なし）
- **@torihanaku/abm** — アカウント階層化・エンゲージメントスコア・ABM戦略生成（閾値config化）（runtime: node, deps: なし）
- **@torihanaku/brand-crisis-monitor** — SNS炎上監視（CrisisSource注入・Reddit一例）・感情分類・24hスパイク検知・アラート（runtime: node, deps: なし）
- **@torihanaku/legal-first-opinion** — 法務文書のAIファーストオピニオン（4法令判定・免責付与）（runtime: node, deps: なし）
- **@torihanaku/autonomous-deploy** — 承認→段階実行→タイムライン記録の自律デプロイ（compensating rollback・adapter注入）（runtime: node, deps: なし）
- **@torihanaku/asset-debt-scanner** — 資産劣化の巡回スキャン→修繕提案フレームワーク（7スキャナ例同梱・AssetScanner注入）（runtime: node, deps: なし）

### インフラ・DB・アセット雛形
- **@torihanaku/infra-templates** — Bun+Cloud Run向けDockerfile/CI/pre-push/起動検証スクリプト＋開発設定(devcontainer/pre-commit gitleaks/prettier)の雛形集（runtime: template, deps: なし。`templates/` のファイルを `{{PLACEHOLDER}}` 置換してコピー）
- **@torihanaku/sql-templates** — マルチテナントSaaSのPostgresマイグレーション雛形8本＋汎用トリガー・RLSヘルパー(updated_at自動更新/ソフトデリート/tenant・user分離RLS)（テナント分離/代理店/課金/監査/GDPR）（runtime: PostgreSQL 14+/Supabase, deps: なし）
- **@torihanaku/eval-lab-py** — AI検索/マッチング機能のLLM評価実験ラボ（FastAPI+SQLite・Python）（runtime: template, deps: なし）
- **@torihanaku/openapi-pipeline** — client/server型共有パイプライン（OpenAPI+Zod+共有型）（runtime: template, deps: なし）
- **@torihanaku/locale-starter** — SaaS汎用UI文言の日英対訳スターター（i18next）（runtime: template, deps: なし）
- **@torihanaku/ops-playbooks** — Sentryアラート/E2E7本/AI-PR運用ランブック＋GitHub Actions security-check(gitleaks+設定検証)集（runtime: template, deps: なし）

## 組み合わせのヒント

- `supabase-dal` は `persistence` の `DalClient` インターフェースを構造的に満たす（import不要でそのまま渡せる）
- `cache` のクライアントは `rate-limiter` の `RateLimiterClient` と同じくioredis互換の構造的インターフェース
- `env-config` で検証したenvを各部品のconfigに渡すのが基本パターン（部品側はenvを読まない）
- `sql-templates` のスキーマは `tenant-resolver` / `agency-access` / `stripe-billing` / `audit-log` / `consent` / `email` の各Storeインターフェースと対応（各READMEにクエリ↔メソッド対応表）
- `stripe-billing` のイベントハンドラ内で `usage-quota` のプラン変更や `email` のトライアル終了通知を呼ぶのが定石
- `agency-access` / `audit-log` を組むとエンプラ向け「委任＋監査証跡」が揃う

## 部品追加の規約

1. パッケージは自己完結（他の@torihanaku/*をimportしない。共有が必要なら最小インターフェースをローカル定義）
2. `process.env` 直読み禁止・secretの値をコード/テスト/READMEに書かない（キー名は可）
3. 構成: `package.json`（@torihanaku/<name>, type:module, exports→src/index.ts）/ `tsconfig.json`（../../tsconfig.base.json継承）/ `src/index.ts` / `src/*.test.ts` / `README.md`（用途1行・API例・注入ポイント・想定ランタイム・出典）
4. 検証: リポルートで `npx tsc --noEmit -p packages/<name>/tsconfig.json` と `npx vitest run packages/<name>` が通ること
5. 追加したらこのAGENTS.mdの索引に1行追記
