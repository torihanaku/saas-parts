# @torihanaku/env-config

zod ベースの環境変数ハーネス `defineEnv(schema)` — 起動時 Fail-Fast 検証（エラー集約表示）/ 必須・オプション分離 / 空文字→undefined 正規化（Cloud Run 対策）/ 型安全アクセス。

## 主要API

```ts
import { z } from "zod";
import { defineEnv, optionalUrl, numericString } from "@torihanaku/env-config";

// 例スキーマ（必須2 + オプション3）— サーバーの先頭で1回だけ呼ぶ
export const env = defineEnv({
  required: z.object({
    DATABASE_URL: z.string().url("DATABASE_URL は有効な URL である必要があります"),
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET は 32文字以上必要です"),
  }),
  optional: z.object({
    APP_URL: optionalUrl,                                              // "" → undefined 正規化つき URL
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: numericString.optional(),                                    // 数字のみの文字列
  }),
});

env.DATABASE_URL; // string（型推論される）
env.APP_URL;      // string | undefined
```

検証失敗時は元コードと同一フォーマットでエラーを集約表示して `process.exit(1)`:

```
[env] 環境変数の検証に失敗しました。起動を中止します。
  • DATABASE_URL: DATABASE_URL は有効な URL である必要があります
  • SESSION_SECRET: SESSION_SECRET は 32文字以上必要です
```

その他:

- `defineEnv(schema, { onFail: "throw" })` — exit の代わりに `EnvValidationError`（`issues: {path, message}[]` 付き）を throw。テストや非 Node ランタイム向け
- `defineEnv(z.object({...}))` — required/optional 分離なしのフラットなスキーマも可
- `emptyToUndefined(schema)` — 任意のスキーマに "" → undefined 前処理を付与（Cloud Run では未設定 env var が "" で渡ることがある）
- `getOptionalEnv(key)` — スキーマ外キーの escape hatch（原則スキーマに追加すること）

## 依存

peerDependencies: `zod`（^3.25 または ^4）

## 設定ポイント（何を注入するか）

- スキーマ: プロダクト固有の変数定義は呼び出し側が持つ（元の ~40 個のフラグ定義は移植していない）
- `source`: 検証対象（デフォルト `process.env`。テストでは fake オブジェクトを渡す）
- `logger` / `exit`: 失敗時の出力先と exit 実装（デフォルト `console.error` / `process.exit`。注入した exit が終了しない場合も不正な env は返さず throw する）

## 想定ランタイム

any（`onFail: "exit"` のデフォルト動作のみ `process` に依存。edge 等では `onFail: "throw"` を使う）

## 出典

- `dev-dashboard-v2/server/lib/env.ts`（parseEnv のエラー集約・optionalUrl 正規化・merge 構成を移植）
- テスト: `dev-dashboard-v2/tests/env.test.ts`
