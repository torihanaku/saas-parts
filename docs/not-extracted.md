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

## まだ残っているもの（最終・これで打ち止め）
- **budgetGuard** — 実装がモックのまま（実データ集計が入れば予算ガードとして汎用化可）
- 広告予算最適化・CPAガードレール・マーケ負債スキャナ・PR文生成・記者CRM・ABM・brandLint・challenger・twin残部・legal/first-opinion — マーケティング製品固有。その製品を作る時に元リポから直接掘る
- ルート302本・画面135枚・製品テスト・locale JSON — 配線とUI（部品価値なし）
