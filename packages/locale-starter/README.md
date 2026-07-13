# @torihanaku/locale-starter

## 用途

SaaS の**どのプロダクトでも必ず要る「汎用 UI 文言」の日英対訳スターター**です。ログイン・サインアップ・設定・通知・オンボーディング・エラーバウンダリなど、製品ドメインに依存しない文言だけを抜き出した `ja.json` / `en.json` と、react-i18next の初期化テンプレート `i18n.ts` を `templates/` に収録しています（コンパイル対象コードではなく、コピーして使うテンプレート。`src/` を持たないため saas-parts の tsc / vitest の対象外）。

出典: `実運用SaaS/src/locales/ja.json`・`en.json`（全 126〜127 グループ・各 20 万文字超）から、**ドメイン非依存の 14 グループのみ**を抽出。製品ブランド名は `{{APP_NAME}}` プレースホルダに置換済み。秘密情報・実プロジェクト ID は含みません。

## 収録ファイル

```
templates/
├── ja.json     # 日本語（14 グループ）
├── en.json     # 英語（同じ 14 グループ・キー構造は ja と一致）
└── i18n.ts     # i18next + react-i18next + LanguageDetector 初期化テンプレート
```

## 収録している 14 グループ（汎用と判断したもの）

| グループ | 内容 |
|---|---|
| `common` | edit / cancel / retry / loading / save / delete / back など汎用ボタン・状態語 |
| `settings` | 設定画面の共通ラベル（タブ・接続/切断・API キー・プライバシー・課金） |
| `topBar` | ヘッダー（メニュー開閉・サーバー状態 live/offline・最終更新）※`title` はブランド→`{{APP_NAME}}` |
| `login` | ログイン（メール/パスワード・エラー各種・SSO 検出・Google 継続） |
| `signup` | サインアップ（確認パスワード不一致・既存アカウント・成功） |
| `forgotPassword` | パスワード再設定 |
| `notifications` | 通知ドロワー（既読化・空・件数オーバーフロー） |
| `errorBoundary` | エラーバウンダリ（再試行・ホームへ戻る） |
| `onboarding` | 初回オンボーディング（ウェルカム・チーム・通知/テーマ設定・業種/目標/チャネル選択） |
| `language` | 言語名（ja / en） |
| `cookieConsent` | Cookie 同意バナー |
| `mobileNav` | モバイル下部ナビ（ホーム/タスク/チャット/レポート/設定） |
| `status` | 汎用ステータスラベル |
| `pwa` | PWA インストール導線 ※ブランド→`{{APP_NAME}}` |

## 落としたグループ（製品固有・126 グループ）

抽出元は**製品機能の文言が大半**だったため、以下のようなドメイン固有グループはすべて除外しました（代表例）:

- **プロダクト機能画面**: `intelligence` / `decisions` / `contentStudio` / `actionBoard` / `autoPilot` / `marketing` / `marketingRoi` / `crm` / `pipeline` / `benchmark` / `causal` / `abTesting` / `budgetAllocation` / `navigator` / `analytics` / `reports` / `metrics` / `dora`
- **その製品固有のブランド機能**: `brandCrisis` / `brandDna` / `firewall` / `firewallEval` / `roiPredict` / `legalOpinion` / `martechLab` / `digitalTwin`(=`twin`) / `chiefOfStaff`(=`cos`) / `characterStudio` 系
- **プロダクトの主ナビ**: `sidebar`（93 キー・製品固有ナビ項目が大半）・`pageTitle`（各機能ページのタイトル）
- **その他 SaaS 基盤だが実装依存が強いもの**: `team` / `teamManagement` / `security` / `sso` / `pricing` / `upgradeModal` / `integrations` / `billing` 系 — これらは「汎用に見えて実装（プラン体系・権限モデル）に密結合」だったため今回は落としました。必要なら元リポから同じ手順で追加抽出できます。

（全 126 グループのうち、上に挙げていないものも同様の理由で除外しています。）

## 使い方

1. `templates/ja.json` / `en.json` / `i18n.ts` を自プロジェクトの `src/locales/`（i18n.ts は `src/`）にコピー
2. `{{APP_NAME}}` を自プロダクト名に一括置換（`topBar.title`・`pwa.install.*` の 3 箇所）
3. `onboarding` の `industries` / `goals` / `channels` は元プロダクト（マーケティング系 SaaS）の選択肢が入っているので、自プロダクトの選択肢に差し替え
4. アプリのエントリで `import './i18n'` して初期化、コンポーネントでは `const { t } = useTranslation()` → `t('common.save')` のように参照
5. 製品固有の文言グループは各自で追加（このスターターは「土台の汎用分」だけを提供）

## 注意 / 前提

- `i18n.ts` の JSON import パスは、テンプレートでは 3 ファイルを同階層に置く前提で `./ja.json` / `./en.json` にしてあります（元リポは `./locales/*.json`）。配置に合わせて調整してください。
- `ja.json` と `en.json` はキー構造が一致しています（`fallbackLng: 'ja'`）。キーを足すときは必ず両方に足してください。
- 依存: `i18next` / `react-i18next` / `i18next-browser-languagedetector`。JSON 自体は依存なし。

## 出典

`実運用SaaS/src/locales/{ja,en}.json` および `src/i18n.ts`。
