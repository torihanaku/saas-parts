# @torihanaku/setup-wizard

セルフホスト型 SaaS の初期セットアップを段階的にガイドします。ステップ定義の config 化、サービスごとの検証関数レジストリ（接続確認）、オンボーディング進捗チェックリストを提供します。

`process.env` を一切参照しません。設定状態は `ConfigResolver` で、接続確認の HTTP は `FetchLike` で注入します。

## 用途

- セットアップステップの状態表示（各サービスが設定済みか、完了率）
- 資格情報の接続/形式検証（保存せずライブチェック）
  - ネットワーク検証: anthropic / supabase / github（接続確認）
  - 形式検証: nango（20文字以上）/ slack（xoxb-）/ stripe（sk_live_/sk_test_）
- オンボーディング進捗チェックリスト（DB接続・AI設定・初回コンテンツ等 8項目）

## API例

```ts
import { SetupWizard } from "@torihanaku/setup-wizard";

const wizard = new SetupWizard({
  // env / BYOK テナントシークレット等をここで解決（process.env はホスト側）
  isConfigured: (key) => resolveConfig(key),   // key: "SUPABASE_URL" 等 → boolean
  // 接続確認の fetch を注入（省略時 globalThis.fetch）
  fetchImpl: (url, init) => fetch(url, init),
  // チェックリストのデータ源
  checklist: {
    isDatabaseConfigured: () => !!dbUrl,
    isAiConfigured: () => !!aiKey,
    hasRows: (dataset) => countRows(dataset) > 0, // content/report/backlog/knowledge/integration/crm
  },
});

// GET /api/setup/status 相当
const status = await wizard.status();
// { setup_complete, required_complete, steps[], completion_percentage }

// POST /api/setup/validate 相当（result.valid で 200/422 を判定）
const res = await wizard.validate("stripe", { STRIPE_SECRET_KEY: "sk_test_..." });
// res.ok なら res.data = { status: 200|422, result: ValidateResult }

// GET /api/setup/checklist 相当
const checklist = await wizard.checklist();
// { items[], completed_count, total_count }
```

ステップ定義や個別バリデータの直接利用も可能です:

```ts
import { computeStatus, DEFAULT_SETUP_STEPS, validateSlack } from "@torihanaku/setup-wizard";
await computeStatus(DEFAULT_SETUP_STEPS, (k) => isSet(k));
validateSlack({ SLACK_BOT_TOKEN: "xoxb-...", SLACK_SIGNING_SECRET: "..." });
```

## 注入ポイント

- `ConfigResolver` — `(key) => boolean | Promise<boolean>`。元実装の `getOptionalEnv(k)` + BYOK テナントシークレット参照を置換（`ai` ステップの ANTHROPIC_API_KEY もこのリゾルバに集約）
- `FetchLike` — 接続確認の HTTP。元実装の `fetch` を注入 IF 化（テストでモック可）
- `ChecklistDataProvider` — チェックリストのデータ源。元実装の Supabase 行カウント（`dd_content_drafts` / `dashboard_reports` / `dashboard_backlog` / `dd_knowledge_items` / `nango_connections` / `dd_crm_deals`）＋ DB/AI 設定判定を置換
- `steps` — ステップ定義の上書き（既定 `DEFAULT_SETUP_STEPS` 6件）
- `validators` — サービス別バリデータの追加/上書き

## 設定キー（ステップ → env_vars）

| ステップ | 必須 | env_vars |
|---|---|---|
| database (Supabase) | ✔ | SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY |
| ai (Claude API) | ✔ | ANTHROPIC_API_KEY |
| github | – | GH_TOKEN |
| nango | – | NANGO_SECRET_KEY |
| slack | – | SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET |
| billing (Stripe) | – | STRIPE_SECRET_KEY |

このパッケージは DB スキーマを持ちません（設定状態・行の有無を注入で受け取るだけ）。チェックリストが参照する行の存在は上記 6 テーブルに対応します。

## 元実装からの変更点

- `process.env` / `getOptionalEnv` / `env` 参照 → `ConfigResolver` 注入（キー名で問い合わせ）
- 接続確認の `fetch` → `FetchLike` 注入（形式のみの nango/slack/stripe は純関数のまま）
- Supabase 行カウント（チェックリスト）→ `ChecklistDataProvider` 注入
- ステップ定義・ラベル・action_url・検証メッセージ（日本語）・Supabase 406 許容・トークン形式チェックはそのまま移植
- HTTP `Response` → `ServiceResult<T>` / `SetupStatus` / `ChecklistResult`。validate は `{ status: 200|422, result }` を返す（元の 200/422 分岐を保持）
- 管理者限定（`requireRole(req, "admin")`）はホスト側の責務として除外

## 出典

- `dev-dashboard-v2/server/routes/setup-wizard.ts`
- `dev-dashboard-v2/server/lib/setup-validators.ts`
```
