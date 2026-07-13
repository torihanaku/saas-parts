# @torihanaku/config-management

環境変数レジストリ（宣言的な設定変数カタログ + 必須/依存関係検証 + マスク付きステータス + .env テンプレート生成）と、外部サービスのヘルスチェックバリデータ（プラガブルレジストリ + 組み込み8種）。

移植元: 実運用SaaS `server/lib/config-registry.ts` + `server/lib/config-validator.ts`

## @torihanaku/env-config との関係（重複ではない）

- **env-config**: zod スキーマで env を**起動時に検証して型安全に読む**ためのハーネス（Fail-Fast・型推論）
- **config-management**: 設定変数の**メタデータカタログ**（説明・カテゴリ・機密フラグ・feature flag・依存関係）を管理し、**管理画面向けステータス表示 / .env テンプレート生成 / 外部サービス疎通チェック**を行う

併用パターン: 起動時の検証と読み取りは env-config、設定管理 UI・ヘルスチェック・オンボーディング用テンプレートは config-management。本パッケージは env-config を import しない（自己完結）。

## 設定レジストリ

```ts
import {
  type ConfigVar, validateConfig, getConfigStatus,
  isConfigured, generateEnvTemplate,
} from "@torihanaku/config-management";

// 自プロダクトの変数カタログを定義（EXAMPLE_CONFIG_REGISTRY 参照）
const registry: ConfigVar[] = [
  { key: "APP_URL", category: "core", required: true, description: "Application base URL", descriptionJa: "アプリのURL", sensitive: false },
  { key: "MAIL_API_KEY", category: "integration", required: false, description: "Mail API key", descriptionJa: "メールAPIキー", featureFlag: "email", sensitive: true },
  { key: "MAIL_FROM", category: "integration", required: false, description: "Sender", descriptionJa: "送信元", defaultValue: "noreply@example.com", sensitive: false, dependsOn: ["MAIL_API_KEY"] },
];

const getValue = (key: string) => process.env[key]; // 値の取得は注入

validateConfig(registry, getValue);        // [{ key, message }] — 必須欠落 + dependsOn 違反
getConfigStatus(registry, getValue);       // カテゴリ別ステータス（sensitive は "abcd****wxyz" マスク）
isConfigured(registry, getValue, "email"); // feature flag 単位の設定済み判定
generateEnvTemplate(registry, { title: "My App", includeOptional: false }); // .env 雛形
```

## ヘルスチェックバリデータ

組み込み: supabase / anthropic / github / slack / stripe / redis / resend / openai（すべて fetch ベース・認証情報は設定で注入・5秒タイムアウト）。

```ts
import { createBuiltinValidators, createHealthCheckRunner } from "@torihanaku/config-management";

const runner = createHealthCheckRunner(createBuiltinValidators({
  supabase: { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY },
  anthropic: { apiKey: env.ANTHROPIC_API_KEY },
  github: { token: env.GH_TOKEN },
  slack: { botToken: env.SLACK_BOT_TOKEN, clientId: env.SLACK_CLIENT_ID },
  redis: { host: env.REDIS_HOST, isConnected: () => redis.status === "ready" },
}));

await runner.runAll();        // HealthCheck[]（未設定サービスは status: "skipped"）
await runner.run("supabase"); // 単体実行（未知の名前は null）
runner.register("my-db", async () => ({ service: "my-db", category: "database", status: "ok" })); // 独自バリデータ追加
```

個別ファクトリ（`createSupabaseValidator` 等）も export しており、必要なものだけ組むことも可能。`fetchImpl` / `timeoutMs` を注入できる。

## 変更点（移植元との差分）

- 製品固有の `CONFIG_REGISTRY` 定数 → 呼び出し側供給（汎用リネーム例 `EXAMPLE_CONFIG_REGISTRY` を同梱）
- `getOptionalEnv` / `env` 直接参照 → `getValue(key)` / バリデータ設定オブジェクトを注入（process.env 非依存）
- category 固定 union → 任意文字列。テンプレート生成のカテゴリ順・ラベルはオプション化
- 固定8サービスの switch → `createHealthCheckRunner` によるプラガブルレジストリ（組み込みはオプトイン）
- Redis チェックの `isRedisConnected` import → `isConnected` 関数注入

## ランタイム要件

- `fetch` / `AbortSignal.timeout` が使える環境（Node 18+ / Bun / edge）。依存パッケージなし。
