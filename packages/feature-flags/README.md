# @torihanaku/feature-flags

## 用途

環境変数トグル＋テナント別オーバーライド＋監査証跡つきのフィーチャーフラグ判定（未知フラグは安全側デフォルトOFF）。

## 主要API（コード例）

```ts
import {
  FeatureFlagClient,
  defineFlags,
  InMemoryOverrideStore,
  processEnvSource,
} from "@torihanaku/feature-flags";

// 1. フラグ定義はレジストリとして呼び出し側が渡す（キーのユニオンで型安全）
const FLAGS = defineFlags({
  "new-dashboard": {
    label: "New Dashboard",
    requiredVars: ["NEW_DASHBOARD_API_KEY"],
    enabled: (env) => !!env.NEW_DASHBOARD_API_KEY, // キー存在で ON
  },
  "beta-export": {
    label: "Beta Export",
    requiredVars: ["ENABLE_BETA_EXPORT"],
    enabled: (env) => env.ENABLE_BETA_EXPORT === "true", // "true" 明示で ON
  },
});

// 2. クライアント生成（env はプレーンな record を注入。process.env は暗黙に読まない）
const client = new FeatureFlagClient({
  flags: FLAGS,
  env: { NEW_DASHBOARD_API_KEY: "..." }, // または processEnvSource() でオプトイン
  overrides: new InMemoryOverrideStore(),  // 省略可（省略時オーバーライドなし）
  audit: { record: (e) => console.log("[audit]", e) }, // 省略可（省略時 no-op）
});

// 3. 判定
client.isEnabled("new-dashboard");           // infra（env由来）レイヤーのみ。未知キーは false
await client.resolveFlags("tenant-1");       // (infra AND global AND tenant) OR elevation
await client.getFlagDetails("tenant-1");     // 各レイヤーの値を可視化（管理UI向け）
client.getRequiredVars("beta-export");       // ["ENABLE_BETA_EXPORT"]
client.getLabel("beta-export");              // "Beta Export"（未定義ならキーそのもの）
client.featureNotConfigured("beta-export");  // 501 JSON Response
client.isCanaryEnabled("new-dashboard", "tenant-1", "NEW_DASHBOARD_CANARY_TENANT_IDS");

// 4. オーバーライド変更（書込 → キャッシュ無効化 → 監査イベント記録）
await client.setGlobalOverride("beta-export", false, "admin@example.com");
await client.setTenantOverride("tenant-1", "beta-export", true, "admin@example.com");
await client.removeGlobalOverride("beta-export");
await client.removeTenantOverride("tenant-1", "beta-export");
```

解決の優先順位（元実装のまま）:
`resolved = (infra(env由来) AND globalOverride AND tenantOverride) OR elevation`
— 未設定のオーバーライドは true 扱い（影響なし）、infra が false なら global override では ON にできず、テナント elevation（元実装の BYOK 相当）だけが単独で ON にできる。オーバーライドは 60 秒 TTL でキャッシュされ、`clearGlobalOverridesCache()` / `clearTenantOverridesCache(tenantId)` / `clearElevationCache(tenantId)` で無効化できる。

## 依存

なし（外部パッケージへの依存ゼロ。テストのみ vitest）。

## 設定ポイント（何を注入するか）

| 注入物 | 型 | デフォルト |
|---|---|---|
| `flags` | `FlagRegistry<K>`（必須） | — フラグ定義（enabled 判定関数・label・requiredVars） |
| `env` | `Record<string, string \| undefined>` | `{}`（`processEnvSource()` を渡すと process.env をオプトイン利用） |
| `overrides` | `FlagOverrideStore`（list/upsert/delete、global＋tenant） | なし（オーバーライドなし。書込メソッドは省略可＝読み取り専用ストアも可） |
| `audit` | `FlagAuditSink`（override 変更ごとに `FlagAuditEvent` を受け取る） | no-op |
| `elevate` | `TenantElevator<K>`（tenantId → 部分フラグ。元実装の BYOK 昇格の一般化） | なし |
| `cacheTtlMs` | number | 60000（元実装の CACHE_TTL 定数） |

`FlagOverrideStore` は元実装が Supabase テーブル
`feature_flag_global_overrides` / `feature_flag_tenant_overrides` に対して行っていた操作
（`SELECT flag_key, enabled`／`POST merge-duplicates（updated_by つき）`／`DELETE`）を
そのままインターフェース化したもの。実装例は `InMemoryOverrideStore` を参照。

## 想定ランタイム

any（Node / Bun / edge。`fetch` の `Response` が存在すればよい。`processEnvSource()` を使う場合のみ `process.env` が必要）

## 出典

- `dev-dashboard-v2/server/lib/feature-flags.ts`（フラグ計算・オーバーライドキャッシュ・resolveFeatureFlags・details・canary・featureNotConfigured）
- `dev-dashboard-v2/server/routes/feature-flag-overrides.ts`（upsert/delete → キャッシュ無効化 → 監査、`updated_by: email || "unknown"` の挙動）
