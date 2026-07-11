# 不採用台帳 — dev-dashboard から抽出しなかったもの

> バッチ3の全数機械監査（2026-07-11、server/lib 61・services 30・jobs 17・mcp 12・hooks 25 を全件分類）で「製品固有」と判定し、意図的に残置したものの台帳。将来「あの機能もあったはず」となったときの再発掘用。元リポ: `~/torihanaku/dev-dashboard-v2`（無変更で保存）。

## 判定基準
- **抽出済み**: どのSaaSでも使える汎用メカニズム → packages/ に68パッケージ
- **残置**: あの製品（マーケティング/ブランド管理ドメイン）の業務ロジックそのもの。汎用化すると意味が消えるもの

## 残置した主な機能群（元パスつき）

### マーケティング・広告ドメイン
- **budget-optimizer / budget-reallocator / budget-allocator/** (~1,400行) — 広告予算の自動再配分（Google/Meta/TikTok Ads固有のアダプタ・閾値）
- **cpaGuardrail / cpaGuardrailCheck** — CPA閾値ガードレール（広告プラットフォーム固有）
- **nangoAdsIngest / adsIngestDaily / nango-client/operations/sync** (~1,000行) — Nango経由の広告・CRM同期（プラットフォーム結合が深い。パターンは各パッケージREADME参照）
- **marketing-intelligence / marketing-roi/（attribution/markov/shapley含む）/ marketing/connectors** — マルチタッチアトリビューション（markov/shapleyは純アルゴリズムだが製品データ形状に密結合）
- **marketing-debt-scorer + scanners 9本** (~1,600行) — マーケ資産の鮮度スコアリング
- **abm-service / analytics-aggregator / ai-visibility-job** — ABM層別/GA4等の正規化/AI検索での言及監視

### ブランド・コンテンツドメイン
- **company-dna/ 6ファイル** (~1,700行) — ブランドボイス学習・顧客反応予測（キット候補だったが未依頼領域）
- **brandLint/ / challenger/ / hard-negatives系 / lintRuleEvolution** — ブランドコンプライアンスlint・Safe/Edgyコピー生成・却下学習
- **press-release-engine / media-ledger-service / pr-ops-service** — PR文生成・記者CRM・PRタイミング
- **content-engine / prototype/copy-variants** — ペルソナ別コピー生成
- **compliance/（景表法/特商法/薬機法ルール）** — 日本の規制ルール実装。**マーケSaaSを作るなら再発掘価値あり**

### 製品固有システム
- **COS（Chief of Staff）cos/ 7ファイル+9ルート+hooks 8本** (~2,000行) — 経営アシスタント（Slack/Linear/カレンダー結合）
- **navigator/ 13ファイル** — 競合調査アシスタント（Exa/Perplexity/HN取り込み）
- **twin/（monte-carlo/elasticity以外）** — マーケ・デジタルツイン（数学は stats-sim / kit-causal-inference に抽出済み）
- **forecast/（arima/prophet/moving-average）** — 時系列予測エンジン群（抽象が未成熟と判定。再検討余地あり）
- **state.ts / dashboard-tools.ts / context-builder.ts / report-scheduler.ts** — 製品状態管理・プロンプト組み立て（パターンとしてのみ参照価値）
- **autonomous-deploy/ / deploy-agent系** — SEOコンテンツ等の自律デプロイ
- **legal/first-opinion / eval/firewall-eval** — AI法務見解・firewall精度評価
- **saas-inventory / supabase-schema-drift / auto-heal-sentry / redisCache / supabase-admin(24行)** — 小物（既存パッケージで代替可）

### ルート・画面・フック
- **server/routes/ 302ファイル** — HTTP結線・認可・バリデーションの製品組み合わせ（汎用機構は抽出済みのコアを使う）
- **src/pages/ 135ディレクトリ/ファイル** — UI全部（shadcn非採用のため見た目部品は不採用の方針）
- **hooks**: useAppState(製品型) / useGitHub(REPOS固定) / useProductAccess・useUsageUpgrade(billing結合) / useBrandDna・useCompanyDnaStats・usePatternAlerts(DNA) / useCos系8本 / useTwin / useAbTesting / useBudgetReallocations / useBiasDetections / useCompliance / useInstitutionalMemory系(→kit-decision-memoryにサーバー側は収録済み・クライアントhookは薄いので必要時に書ける)
- **server/mcp/tools-impl-* 5本（37ツール）** — 製品ツール実装（レジストリ機構は kit-ai-agent に抽出済み）

### キットから意図的に落としたもの（各キットREADME「落としたもの」参照）
- kit-approval-workflow: ブランドDNA連携・チャレンジャー生成・デプロイゲート・稟議PDF描画・法務RAG
- kit-causal-inference: HTTPルート・Redisキャッシュ・Sentry通知・Supabase取得
- kit-ai-agent: cms/sns/adアダプタ・cloud-run/nangoエグゼキュータ・異常検知マーケ指標・auto-rollbackのcron部
- kit-decision-memory: slack/notion抽出器・embedding-pipeline（コスト上限管理）・90日リテンションスイープ

## 再発掘候補 → バッチ4で回収済み（2026-07-11）
以下は本台帳の初版で「再発掘候補」だったが、バッチ4ですべて抽出済み:
- ~~compliance/ 日本規制ルール~~ → **@torihanaku/compliance-jp**
- ~~forecast/ 時系列エンジン群~~ → **@torihanaku/forecast-engines**
- ~~markov/shapley アトリビューション~~ → **@torihanaku/attribution-algos**（+ ab-significance）
- ~~company-dna パターン学習~~ → **@torihanaku/kit-pattern-dna**
- ~~white-label/cname-verifier + ssl-provisioner~~（初版で誤って製品固有と分類）→ **@torihanaku/custom-domains**
- ~~COS / navigator / nango統合~~ → **kit-chief-of-staff / kit-research-navigator / kit-integration-manager**
- ~~eval-lab/firewall-eval の評価骨格~~ → **@torihanaku/eval-harness**（Python製eval-lab本体2,200行は移植せず設計思想のみ取込）

## バッチ5で回収済み（2026-07-11・全機能抽出完了）
「まだ残っているもの」として挙げていた製品固有機能も、バッチ5で全部パッケージ化しました:
- ~~AI社員システム~~ → **kit-ai-workforce**（書籍2冊も同梱）
- ~~DORA/デプロイ運用~~ → **kit-devops-metrics**
- ~~採用/文書/書き起こし/スキル/セットアップ~~ → **hiring / documents / transcripts-manager / skills-service / setup-wizard**
- ~~バイアス検知/A/B運用/twin/メモリコネクタ~~ → **bias-detector / ab-testing-service / scenario-twin / memory-connectors**
- ~~広告予算最適化/CPA/analytics正規化/AI露出監視~~ → **ad-budget-optimizer / cpa-guardrail / analytics-normalizer / ai-visibility-monitor**
- ~~brandLint/content生成/challenger~~ → **brand-lint / content-generation / challenger-copy**
- ~~PR/記者CRM/ABM/炎上監視/法務/自律デプロイ/負債スキャナ~~ → **press-media / abm / brand-crisis-monitor / legal-first-opinion / autonomous-deploy / asset-debt-scanner**
- ~~SaaS棚卸し/ホワイトラベル/デイリーブリーフィング/Slackレポート~~ → **saas-inventory / white-label-branding / daily-briefing / slack-reports**
- ~~Python実験ラボ/OpenAPI共有/locale辞書/運用playbook~~ → **eval-lab-py / openapi-pipeline / locale-starter / ops-playbooks**（テンプレート）

## 最終総ざらい（2026-07-11・3体エージェントでリポ全体を再走査）
「本当に一つも残っていないか」を server/フロント・shared/インフラ の3方向で全数再監査。結果=**重要な見落としゼロ・全SaaS能力カテゴリ網羅・過去の分類も全て正しい**と確認。実地検証で見つかった小粒な取りこぼしも全回収:
- ~~transcriptParser（字幕VTT/SRTパーサ160行）~~ → **@torihanaku/transcript-parser**
- ~~RLSトリガー雛形（set_updated_at/ソフトデリート/テナント・ユーザー分離）~~ → **sql-templates** に追加
- ~~security-check.yml（gitleaks+設定検証）~~ → **ops-playbooks** に追加
- ~~devcontainer/pre-commit/prettier設定~~ → **infra-templates** に追加

## 本当に残したもの（部品化しても意味がないもの・打ち止め）
- **HTTPルート302本・画面135枚（JSX）** — 配線とUIそのもの。ロジックは全キット/パッケージに抽出済み。移植先で必ず書き直す部分なので生ファイルは元リポ（dev-dashboard-v2）に保存
- **製品テストコード** — 対象コードとセットでのみ意味を持つ。再利用価値のあるテストは各パッケージに移植済み
- **budgetGuard** — 実装がモックのまま（実データ集計が入れば汎用化可）
- **knowledge-base/・docs/の当時の設計文書** — 参照資料として元リポに保存

元リポ `~/torihanaku/dev-dashboard-v2` は全工程を通じて無変更。いつでも掘り出せる。
