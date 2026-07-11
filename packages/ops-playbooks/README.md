# @torihanaku/ops-playbooks

## 用途

SaaS 運用まわりの**そのまま真似できる運用アセット集**です。Sentry のアラートルール・代表的な Playwright E2E スペック（パターン別）・AI 主導開発の運用ランブックを、コンパイル対象コードではなく**新規プロジェクトにコピーして使うテンプレート**として `templates/` に収録しています（`src/` を持たないため saas-parts の tsc / vitest の対象外）。

出典: `dev-dashboard-v2` の `sentry/` `e2e/` `ops/`。製品固有のブランド名・チャンネル名・プロジェクト slug は `{{PLACEHOLDER}}` に置換済み。秘密情報・実プロジェクト ID は含みません（E2E 内のトークンは元から `test-bypass-token` 等の**偽のテスト用フォールバック値**で、実値は環境変数から注入する設計）。

## 収録ファイル一覧と用途

```
templates/
├── sentry/alert-rules/
│   └── auto-heal.yml          # Sentry アラートルール（自動復旧イベントの通知/エスカレーション）
├── e2e/                        # Playwright E2E スペック（パターン別に 7 本を厳選。元リポは 27 本）
│   ├── api-health.spec.ts      # API 契約スモーク（複数エンドポイントのキー/配列形状を検証）
│   ├── dashboard.spec.ts       # 基本ナビゲーション（タイトル・サイドバー遷移・Cookie 同意）
│   ├── mobile-home.spec.ts     # モバイル（ビューポート指定＋API モックでモバイルホーム検証）
│   ├── white-label-preview.spec.ts  # マルチテナント/ホワイトラベル（テナント別ブランド設定の反映）
│   ├── partner-dashboard.spec.ts    # フィーチャーフラグ・ゲーティング（whiteLabel フラグ ON 前提の画面）
│   ├── firewall-slack-flow.spec.ts  # 認証フロー（Slack HMAC 署名検証・approve/reject/不正署名 401）
│   └── visual-check.spec.ts    # ビジュアル回帰（全ページを時刻固定でスクショ・ナビ存在ガード）
└── ops/
    ├── github-ai-pr-operations.md   # AI 生成 PR のレビュー/マージキュー運用ランブック
    └── agent-handoffs/
        └── README.md                # エージェント間の作業引き継ぎメモの書式・運用ルール
```

### sentry/alert-rules/auto-heal.yml

「自動復旧（auto-heal）」処理の成否イベントを Sentry で受けて、成功→Slack 監査ログ、失敗→PagerDuty ページング、critical→オンコール、warning→Slack、サーキットブレーカ開放→低優先通知、と**深刻度でエスカレーション先を振り分ける**ルール集です。クールダウン（`frequency`）と environment/owner の付け方の実例として使えます。

| プレースホルダ | 意味 |
|---|---|
| `{{SENTRY_PROJECT_SLUG}}` | `sentry-cli` の対象プロジェクト slug |
| `{{SLACK_OPS_CHANNEL}}` / `{{SLACK_ALERTS_CHANNEL}}` | 通知先 Slack チャンネル（監査用 / アラート用） |
| `{{SENTRY_OWNER_TEAM}}` | ルールの owner（`team:<slug>` 形式） |

※ `${PAGERDUTY_INTEGRATION_KEY}` は元から環境変数参照で、実キーは含みません。

### e2e/*.spec.ts（パターン別 7 本）

元リポの 27 本から、**再利用価値の高い「パターンの型」だけ**を選抜しています（全部は入れていません）。共通イディオム: `PREVIEW_URL` 環境変数でターゲット切替、`X-E2E-Bypass` ヘッダーで認証バイパス、`context.route()` で API をモックしてバックエンド非依存にする、という 3 点。認証フロー（HMAC 署名）・マルチテナント分離・モバイル・フィーチャーフラグ・API 契約・ビジュアル回帰・基本ナビ、と**別々のパターンを 1 本ずつ**カバーします。

| プレースホルダ | 意味 |
|---|---|
| `{{APP_NAME}}` | 製品名（タイトル/ロゴ/ブランド名の期待値） |
| `{{APP_SLUG}}` | localStorage キーの接頭辞（例: `<slug>-cookie-consent`） |

### ops/github-ai-pr-operations.md

AI（Codex / Claude / Gemini 等）が書いた PR を、`main` をサーバーサイドチェックで守りつつ**レビュー〜マージキューへ手作業を最小化して流す運用モデル**。ラベル設計（`automerge/eligible` / `queue/hold` / `risk/high`）・merge_group 対応・squash 運用のルールが書かれています。プレースホルダなし・自リポの運用に合わせて読み替えて使用。

### ops/agent-handoffs/README.md

ブランチ単位の作業引き継ぎメモを `AGENTS.md` に追記せず**別ファイルに分離して残す**ための書式（ファイル名規約＋テンプレート）。複数の AI/人間が交代で作業するリポで履歴が汚れるのを防ぎます。プレースホルダなし。

## 適用方法

1. `templates/` の各ディレクトリを自プロジェクトの対応する場所（`sentry/` `e2e/` `ops/`）へコピー
2. `grep -rn '{{' .` で全プレースホルダを洗い出し、上表に従って置換
3. E2E は `@playwright/test` と `playwright.config.ts`（`PREVIEW_URL` / `extraHTTPHeaders` の `X-E2E-Bypass` を設定）が前提。各スペックの API モック（`context.route`）を自 API のパス・レスポンス形状に合わせて調整
4. Sentry ルールは `sentry-cli` で登録。PagerDuty/Slack の連携を先に作成し、`${PAGERDUTY_INTEGRATION_KEY}` を環境変数で渡す
5. ランブック 2 本は自チームの運用に合わせて文言調整

## 除外・placeholder 化したもの

- E2E は 27 本中 **7 本のみ**収録（パターン網羅を優先し、同型の重複スペックは除外）。`ops/tasks/`・`ops/agent-handoffs/` 配下の**個別ブランチの実作業ログ**（日付付き handoff）は製品固有内容のため除外し、書式を示す `README.md` のみ収録。
- ブランド名 `Folia` → `{{APP_NAME}}`、localStorage 接頭辞 `techradar` → `{{APP_SLUG}}`、Sentry project `dev-dashboard` / Slack `#ops`・`#marketing-ops` / owner `team:marketing-ops` → 各プレースホルダに置換。
- E2E 内のトークン（`test-bypass-token` 等）は元から偽のフォールバック値で、実値は環境変数注入。実クレデンシャルは含みません。

## 依存 / 想定ランタイム

E2E: `@playwright/test`。Sentry ルール: `sentry-cli` + Sentry プロジェクト（PagerDuty/Slack 連携）。ランブックは Markdown（実行時依存なし）。TypeScript ビルドには関与しません。

## 出典

`dev-dashboard-v2` の `sentry/alert-rules/`・`e2e/`・`ops/`。
