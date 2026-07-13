# @torihanaku/abm

Account-Based Marketing（ABM）エンジン。CRM 連絡先を会社単位で ABM アカウントに集約し、**tier 判定**・**エンゲージメントスコア**算出・**パーソナライズ戦略生成（LLM）**を行う。実運用SaaS `server/lib/abm-service.ts` の移植。

## 特徴

- **ストア注入式**: 永続化は `AbmStore` インターフェースに抽象化。即戦力の `InMemoryAbmStore` を同梱。
- **LLM 注入式**: `generateJson` を注入（`@torihanaku/claude-api` 互換）。
- **API キー解決も注入式**: 原典の tenant-secret → env fallback を `resolveApiKey` に置換。省略時はキーゲートで戦略生成をスキップ（`process.env` 非依存）。
- **閾値 config 化**: tier / engagement の閾値は `AbmThresholds`。デフォルト（`DEFAULT_THRESHOLDS`）は原典のハードコード値と一致。

## 使い方

```ts
import {
  InMemoryAbmStore,
  getABMAccounts, segmentAccounts, generateABMStrategy, syncABMAccounts,
  type AbmConfig,
} from "@torihanaku/abm";
import { generateJson } from "@torihanaku/claude-api"; // 例: LLM 実装

const store = new InMemoryAbmStore();
const config: AbmConfig = {
  store,
  generateJson,
  resolveApiKey: async (tenantId) =>
    (tenantId ? await getTenantKey(tenantId) : "") || process.env.ANTHROPIC_API_KEY || "",
  // thresholds は省略で DEFAULT_THRESHOLDS
};

// CRM 連絡先/商談 → ABM アカウントへ集約
await syncABMAccounts(config, "proj-1");

// tier セグメントに分割
const segments = await segmentAccounts(config, "proj-1");

// アカウント単位の戦略生成（LLM）
const { strategy, tactics } = await generateABMStrategy(config, "account-id", "tenant-123");
```

## tier / engagement 判定

| tier | 条件（デフォルト） |
| --- | --- |
| tier1 | score ≥ 80 または deal ≥ ¥1,000,000 |
| tier2 | score ≥ 50 または deal ≥ ¥300,000 |
| tier3 | 上記以外 |

| engagement | 条件（デフォルト） |
| --- | --- |
| hot | score ≥ 70 かつ contacts ≥ 3 |
| warm | score ≥ 40 または contacts ≥ 2 |
| cold | 上記以外 |

閾値は `config.thresholds` で上書き可能（`deriveTier` / `deriveEngagement` は単体でも呼べる）。

## `AbmStore` を自前実装する場合

Supabase / Postgres など任意のバックエンドを繋ぐには `AbmStore` の 7 メソッドを実装する（`getAccountsByProject` は score 降順、`getAccountByCompany` は project + company 一致で 1 件、など）。原典の `dd_abm_accounts` / `dd_crm_contacts` / `dd_crm_deals` テーブルに対応する。

## 移植メモ

- `supabaseGet/Insert/Patch` 直呼びを `AbmStore` に集約（sync のクエリ列 `id,company,metadata` / `amount,contact_id` はメソッド戻り値の型に反映）。
- `env.ANTHROPIC_API_KEY` / `getTenantSecret` を `resolveApiKey` に一本化。
- `console.log` ベースのログを `logger`（省略時 no-op）に置換。
- スコア計算・プロンプト・セグメント名は原典のまま。
